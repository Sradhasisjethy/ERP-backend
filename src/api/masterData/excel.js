const ExcelJS = require('exceljs');
const { cellText, isBlank, present, numberFormat, ruleText } = require('./columns');
const { ValidationError } = require('../../core/AppError');

/**
 * Reading and writing the workbooks — the only file in this feature that knows
 * what a worksheet is.
 *
 * The four documents it produces (template, export, error report) all come from
 * the same column list, so a user who downloads the sample, fills it in and
 * uploads it cannot be told the columns are wrong. The same is true of the
 * round trip that matters most in practice: export, edit in Excel, re-import.
 */

const DATA_SHEET = 'Data';
const INSTRUCTIONS_SHEET = 'Instructions';
const MAX_ROWS = 5000;
const MAX_SHEETS = 10;

const ACCENT = 'FF1E3A5F';
const HEADER_FILL = 'FFEFF3F8';
const REQUIRED_FILL = 'FFFDF3E7';
const READONLY_FILL = 'FFF0F0F0';
const BORDER = { style: 'thin', color: { argb: 'FFD8DEE6' } };

/**
 * A cell starting with = + - or @ is executed as a formula when the file is
 * opened, which turns any user-supplied name into code running on the reader
 * machine. Prefixing with an apostrophe neutralises it and is invisible in
 * Excel. The same rule the CSV exporter already applies (utils/exporter.js).
 */
const safeText = (value) => {
  if (typeof value !== 'string') return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
};

/**
 * The characters a spreadsheet reads as the start of a formula, plus the two
 * whitespace ones that can smuggle them in. Written as a set rather than a
 * regular expression so the escaping is not something anyone has to squint at.
 */
const FORMULA_STARTERS = new Set(['=', '+', '-', '@', '\t', '\r']);

/**
 * Undoes `safeText`, so a round trip returns what it started with.
 *
 * The export prefixes a value beginning with one of those characters with an
 * apostrophe, so the reader's spreadsheet treats it as text rather than running
 * it. Read back literally, that apostrophe became part of the value: exporting
 * a product named `=HYPERLINK(...)` and re-importing the untouched file renamed
 * it to `'=HYPERLINK(...)`. An escape the reader does not undo is not an
 * escape — it is data corruption on a round trip.
 */
const unescapeFormulaGuard = (text) =>
  (typeof text === 'string' && text.startsWith("'") && FORMULA_STARTERS.has(text[1])
    ? text.slice(1)
    : text);

/** Header text as it is matched: case and spacing are forgiven, nothing else. */
const normalizeHeader = (text) => String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();

const styleHeaderRow = (row, columns) => {
  row.font = { bold: true, size: 10, color: { argb: ACCENT } };
  row.alignment = { vertical: 'middle', wrapText: true };
  row.height = 26;
  row.eachCell((cell, index) => {
    const column = columns[index - 1];
    cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
    const fill = column?.readOnly ? READONLY_FILL : column?.required ? REQUIRED_FILL : HEADER_FILL;
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  });
};

const sizeColumns = (sheet, columns, sampleRows) => {
  columns.forEach((column, index) => {
    const widths = sampleRows.slice(0, 200).map((row) => String(row[index] ?? '').length);
    const widest = Math.max(column.header.length, ...(widths.length ? widths : [0]));
    sheet.getColumn(index + 1).width = Math.min(Math.max(widest + 4, 12), 46);
  });
};

const addInstructions = (workbook, { label, columns, mode, dependsOn, notes = [] }) => {
  const sheet = workbook.addWorksheet(INSTRUCTIONS_SHEET);
  sheet.getColumn(1).width = 34;
  sheet.getColumn(2).width = 100;

  const heading = (text) => {
    const row = sheet.addRow([text]);
    row.font = { bold: true, size: 12, color: { argb: ACCENT } };
    sheet.mergeCells(row.number, 1, row.number, 2);
  };
  const line = (key, value) => {
    const row = sheet.addRow([key, safeText(value)]);
    row.getCell(1).font = { bold: true, size: 10 };
    row.getCell(2).font = { size: 10 };
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
  };

  heading(`${label} — how to fill this in`);
  sheet.addRow([]);
  line('Sheet to edit', `Put your rows on the "${DATA_SHEET}" sheet. This sheet is ignored on upload.`);
  line('Example rows', 'The sample rows on the Data sheet are examples. Delete them before you upload.');
  line('Matching', mode);
  line('Dates', 'DD/MM/YYYY, for example 01/04/2026.');
  line('Amounts', 'Rupees, not paise. 4500 or 4,500.00 both work.');
  line('Yes / No', 'Type Yes or No.');
  line('Blank cells', 'An optional cell left blank keeps whatever the record already has.');
  line('All or nothing', 'If any row has an error, nothing is imported. Fix the listed rows and upload again.');
  line('Columns', 'Do not rename or add columns. A column this import does not know is refused rather than ignored, so a value you typed is never silently dropped.');
  if (dependsOn) line('Import order', dependsOn);
  notes.forEach((note) => line(note.key, note.value));

  sheet.addRow([]);
  heading('Columns');
  const header = sheet.addRow(['Column', 'Rule']);
  header.font = { bold: true, size: 10, color: { argb: ACCENT } };
  header.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
  });

  for (const column of columns) {
    const row = sheet.addRow([column.header, safeText(ruleText(column))]);
    row.font = { size: 10 };
    row.getCell(2).alignment = { wrapText: true, vertical: 'top' };
    row.eachCell((cell) => { cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER }; });
  }
};

/** The sample workbook: headers, two worked example rows, and the rules. */
const buildTemplate = async ({ label, columns, examples, mode, dependsOn, notes }) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'INFIDEEP ERP';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(DATA_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  const headerRow = sheet.addRow(columns.map((c) => c.header));
  styleHeaderRow(headerRow, columns);

  const exampleRows = (examples || []).map((example) => columns.map((c) => example[c.field] ?? c.example ?? null));
  for (const values of exampleRows) {
    const row = sheet.addRow(values.map(safeText));
    row.font = { size: 10, italic: true, color: { argb: 'FF6B7280' } };
    row.eachCell((cell, index) => {
      const format = numberFormat(columns[index - 1]);
      if (format) cell.numFmt = format;
    });
  }

  sizeColumns(sheet, columns, exampleRows);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  addInstructions(workbook, { label, columns, mode, dependsOn, notes });
  return workbook.xlsx.writeBuffer();
};

/** The export: the same columns, filled with real records. */
const buildExport = async ({ label, columns, records, names, meta }) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = meta?.organizationName || 'INFIDEEP ERP';
  workbook.created = new Date();

  const sheet = workbook.addWorksheet(DATA_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  const headerRow = sheet.addRow(columns.map((c) => c.header));
  styleHeaderRow(headerRow, columns);

  const values = records.map((record) => columns.map((column) => present(column, record, names)));
  values.forEach((rowValues, index) => {
    const row = sheet.addRow(rowValues.map(safeText));
    row.font = { size: 10 };
    row.eachCell((cell, cellIndex) => {
      const column = columns[cellIndex - 1];
      const format = numberFormat(column);
      if (format) cell.numFmt = format;
      cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
      if (index % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    });
  });

  sizeColumns(sheet, columns, values);
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1 + records.length, column: columns.length } };
  addInstructions(workbook, {
    label,
    columns,
    mode: meta?.mode || 'Edit the rows you want to change and upload this same file to update them.',
    dependsOn: meta?.dependsOn,
    notes: meta?.notes,
  });
  return workbook.xlsx.writeBuffer();
};

/**
 * The failed rows, exactly as the user typed them, with the reason appended.
 * Correcting this file and uploading it again is the intended loop, so the
 * original columns keep their headers and their order.
 */
const buildErrorWorkbook = async ({ label, columns, rows }) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'INFIDEEP ERP';

  const sheet = workbook.addWorksheet(DATA_SHEET, { views: [{ state: 'frozen', ySplit: 1 }] });
  const headers = [...columns.map((c) => c.header), 'Import Status', 'Error'];
  const headerRow = sheet.addRow(headers);
  styleHeaderRow(headerRow, columns);
  headerRow.getCell(headers.length - 1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };
  headerRow.getCell(headers.length).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFDECEA' } };

  const values = rows.map((row) => [
    ...columns.map((column) => row.raw?.[column.header] ?? null),
    row.status === 'ERROR' ? 'Failed' : 'Not imported',
    (row.errors || []).map((e) => e.message).join(' | '),
  ]);

  for (const rowValues of values) {
    const row = sheet.addRow(rowValues.map(safeText));
    row.font = { size: 10 };
    row.getCell(headers.length).font = { size: 10, color: { argb: 'FFB42318' } };
    row.eachCell((cell) => { cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER }; });
  }

  sizeColumns(sheet, headers.map((header) => ({ header })), values);
  addInstructions(workbook, {
    label,
    columns,
    mode: 'Fix the rows on the Data sheet, delete the Import Status and Error columns, and upload the file again.',
  });
  return workbook.xlsx.writeBuffer();
};

/**
 * Reads an uploaded workbook into raw rows keyed by the header text.
 *
 * Refuses the file rather than guessing whenever the shape is wrong: a missing
 * column, a repeated column, or a column we do not know are all reported here,
 * before a single cell is interpreted. An unknown column is a hard refusal on
 * purpose — the alternative is dropping a value the user deliberately typed.
 */
const readWorkbook = async (buffer, columns, { optionalHeaders = [], ignoreHeaders = [] } = {}) => {
  const optional = new Set(optionalHeaders.map(normalizeHeader));
  // Columns the export writes for the reader but the import never reads, such
  // as a product name printed beside its code. They must be *accepted*: an
  // exported file that could not be uploaded again would break the one loop
  // this feature exists for.
  const ignored = new Set(ignoreHeaders.map(normalizeHeader));
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch {
    throw new ValidationError('That file could not be opened as an Excel workbook. Save it as .xlsx and try again.');
  }

  const sheets = workbook.worksheets.filter((sheet) => sheet.state !== 'veryHidden');
  if (!sheets.length) throw new ValidationError('That workbook has no sheets.');
  if (sheets.length > MAX_SHEETS) throw new ValidationError(`That workbook has ${sheets.length} sheets — at most ${MAX_SHEETS} are read.`);

  const sheet = sheets.find((s) => normalizeHeader(s.name) === normalizeHeader(DATA_SHEET)) || sheets[0];

  const headerRow = sheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    headers[colNumber - 1] = cellText(cell.value).trim();
  });
  if (!headers.some((header) => !isBlank(header))) {
    throw new ValidationError('The first row of the Data sheet must hold the column names.');
  }

  const expected = new Map(columns.map((column) => [normalizeHeader(column.header), column]));
  const seen = new Map();
  const unknown = [];
  const duplicated = [];

  headers.forEach((header, index) => {
    if (isBlank(header)) return;
    const key = normalizeHeader(header);
    if (seen.has(key)) duplicated.push(header);
    else seen.set(key, index);
    if (!expected.has(key) && !ignored.has(key)) unknown.push(header);
  });

  // A rate column is optional for a role that may not see rates: their sample
  // file does not carry it, and refusing their upload for a column they were
  // never offered would lock them out of the import entirely (BR-27).
  const missing = columns.filter(
    (column) =>
      !column.exportOnly
      && !optional.has(normalizeHeader(column.header))
      && !seen.has(normalizeHeader(column.header))
  );
  const problems = [];
  if (missing.length) problems.push(`Missing column${missing.length === 1 ? '' : 's'}: ${missing.map((c) => c.header).join(', ')}`);
  if (duplicated.length) problems.push(`Repeated column${duplicated.length === 1 ? '' : 's'}: ${[...new Set(duplicated)].join(', ')}`);
  if (unknown.length) problems.push(`Column${unknown.length === 1 ? '' : 's'} this import does not accept: ${unknown.join(', ')}`);
  if (problems.length) {
    throw new ValidationError(
      `${problems.join('. ')}. Download the sample file for the exact column names this import expects.`
    );
  }

  const rows = [];
  const lastRow = sheet.actualRowCount || sheet.rowCount;
  for (let rowNumber = 2; rowNumber <= lastRow; rowNumber += 1) {
    const excelRow = sheet.getRow(rowNumber);
    const raw = {};
    let hasValue = false;
    for (const column of columns) {
      const index = seen.get(normalizeHeader(column.header));
      if (index === undefined) continue;
      const value = excelRow.getCell(index + 1).value;
      raw[column.header] = value instanceof Date ? value : unescapeFormulaGuard(cellText(value).trim()) || null;
      if (!isBlank(raw[column.header])) hasValue = true;
    }
    // A sheet that had rows deleted keeps their empty shells. Skipping them is
    // the difference between "12 errors" and a clean import.
    if (!hasValue) continue;
    rows.push({ rowNumber, raw });
    if (rows.length > MAX_ROWS) {
      throw new ValidationError(`That file has more than ${MAX_ROWS.toLocaleString('en-IN')} rows. Split it and import in parts.`);
    }
  }

  if (!rows.length) throw new ValidationError('That file has column headings but no data rows.');
  return { sheetName: sheet.name, rows };
};

module.exports = { buildTemplate, buildExport, buildErrorWorkbook, readWorkbook, safeText, unescapeFormulaGuard, MAX_ROWS, DATA_SHEET };
