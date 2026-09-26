const ExcelJS = require('exceljs');
const { excelNumberFormat, excelValue, formatValue, formatDateTime } = require('./format');

/**
 * Excel export.
 *
 * The point of this file is that the result is a *working spreadsheet*, not a
 * grid of strings: numeric cells hold numbers with a number format, so the
 * reader can re-sort, re-total and pivot. A CSV dump cannot do that, which is
 * why this replaced one.
 *
 * It is written **as a stream**, row by row, straight to the response.
 *
 * It used to build the whole workbook in memory and hand back one buffer.
 * Measured: 10,000 rows held 235 MB of heap and blocked the event loop for
 * five seconds; 50,000 rows held a gigabyte and blocked it for twenty-five.
 * During that time every other user's request waited — a single large export
 * stalled the whole tenant base. Streaming keeps memory flat (each row is
 * formatted, written and gone) and yields to the event loop between writes,
 * so a large export slows the person downloading it rather than everyone.
 *
 * Layout, top to bottom:
 *   1. a compact title block — organisation, report, one line of context
 *   2. the summary figures, laid across
 *   3. the table: bold header, frozen, auto-filtered, banded, with a totals row
 *
 * Streaming has one rule the buffered writer did not: column widths must be
 * declared before the first row is committed. They are sized from a sample of
 * the data, which is already in memory at this point.
 */

const ACCENT = 'FF1E3A5F';
const HEADER_FILL = 'FFEFF3F8';
const BORDER = { style: 'thin', color: { argb: 'FFD8DEE6' } };
const ALL_BORDERS = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };

/** Excel rejects : \ / ? * [ ] in a sheet name and caps it at 31 characters. */
const sheetNameFor = (definition) => definition.name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31);

const columnWidths = (columns, rows, settings) =>
  columns.map((column) => {
    const sample = rows.slice(0, 200).map((r) => formatValue(r[column.key], column, settings).length);
    const widest = Math.max(column.header.length, ...(sample.length ? sample : [0]));
    return Math.min(Math.max(widest + 3, 10), 46);
  });

/**
 * Writes the workbook to `stream` (normally the HTTP response) and resolves
 * when the last byte has been handed to it.
 */
const buildXlsx = async ({ definition, columns, rows, summary, metrics, meta, settings }, stream) => {
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream,
    useStyles: true,
    // Shared strings would mean holding every distinct string until the end,
    // which is the memory profile this rewrite exists to remove.
    useSharedStrings: false,
  });
  workbook.creator = meta.organizationName;
  workbook.created = meta.generatedAt;

  const sheet = workbook.addWorksheet(sheetNameFor(definition), {
    pageSetup: { orientation: columns.length > 8 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const span = Math.max(columns.length, 4);
  sheet.columns = columnWidths(columns, rows, settings).map((width) => ({ width }));

  const titleRow = (text, { size = 11, bold = false, color = 'FF1F2933' }) => {
    const row = sheet.addRow([text]);
    row.font = { size, bold, color: { argb: color } };
    if (span > 1) sheet.mergeCells(row.number, 1, row.number, span);
    row.commit();
    return row;
  };

  // Two title lines and one context line, rather than eight stacked ones.
  titleRow(meta.organizationName, { size: 14, bold: true, color: ACCENT });
  titleRow(definition.description ? `${definition.name} — ${definition.description}` : definition.name, { size: 11, bold: true });
  titleRow(
    [
      meta.periodLabel,
      meta.locationLabel,
      meta.filterLabel,
      `Amounts in ${settings.currency}`,
      `Generated ${formatDateTime(meta.generatedAt)} by ${meta.userName}`,
    ]
      .filter(Boolean)
      .join('  ·  '),
    { size: 9, color: 'FF52606D' }
  );
  if (!meta.canViewRates) {
    titleRow('Rate and amount columns are excluded — your role does not permit viewing them.', {
      size: 9,
      bold: true,
      color: 'FFB42318',
    });
  }

  if (metrics.length) {
    sheet.addRow([]).commit();
    // Labels across, figures beneath: one glance instead of seven rows.
    const labels = sheet.addRow(metrics.map((item) => item.label));
    labels.font = { size: 9, color: { argb: 'FF52606D' } };
    labels.eachCell((cell) => { cell.alignment = { horizontal: 'right', wrapText: true }; });
    labels.commit();

    const values = sheet.addRow(metrics.map((item) => excelValue(summary[item.key], item)));
    values.font = { size: 11, bold: true };
    values.eachCell((cell, index) => {
      const numFmt = excelNumberFormat(metrics[index - 1].type, settings);
      if (numFmt) cell.numFmt = numFmt;
      cell.alignment = { horizontal: 'right' };
      cell.border = { bottom: BORDER };
    });
    values.commit();
  }

  sheet.addRow([]).commit();

  const headerRow = sheet.addRow(columns.map((c) => c.header));
  headerRow.font = { bold: true, size: 10, color: { argb: ACCENT } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  headerRow.alignment = { vertical: 'middle', wrapText: true };
  headerRow.height = 22;
  headerRow.eachCell((cell, index) => {
    cell.border = ALL_BORDERS;
    cell.alignment = { ...cell.alignment, horizontal: columns[index - 1].align };
  });
  const headerRowNumber = headerRow.number;
  headerRow.commit();

  // Freeze everything above and including the header, so scrolling a long
  // report keeps both the column names and the context block that says what
  // filters produced it.
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];

  const numFmts = columns.map((column) => excelNumberFormat(column.type, settings));
  for (const [index, record] of rows.entries()) {
    const row = sheet.addRow(columns.map((c) => excelValue(record[c.key], c)));
    row.font = { size: 10 };
    row.eachCell((cell, cellIndex) => {
      const column = columns[cellIndex - 1];
      if (numFmts[cellIndex - 1]) cell.numFmt = numFmts[cellIndex - 1];
      cell.alignment = { horizontal: column.align, vertical: 'top', wrapText: column.type === 'text' };
      cell.border = ALL_BORDERS;
      // Banding makes a wide row traceable across the page without a ruler.
      if (index % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    });
    row.commit();

    // Hand the event loop back often: this is what lets other users' requests
    // interleave with a long export instead of waiting for it. A hundred rows
    // is ~15 ms of formatting, so nothing else waits longer than that.
    if (index % 100 === 99) await new Promise((resolve) => setImmediate(resolve));
  }

  // Totals for columns that declared themselves totalable. Written as a SUM
  // formula rather than a precomputed constant so the figure survives the
  // reader deleting a row.
  const totalColumns = columns.filter((c) => c.total);
  if (totalColumns.length && rows.length) {
    const firstDataRow = headerRowNumber + 1;
    const lastDataRow = headerRowNumber + rows.length;
    const totals = sheet.addRow(
      columns.map((column, index) => {
        if (index === 0) return 'TOTAL';
        if (!column.total) return null;
        const letter = sheet.getColumn(index + 1).letter;
        return { formula: `SUM(${letter}${firstDataRow}:${letter}${lastDataRow})` };
      })
    );
    totals.font = { bold: true, size: 10 };
    totals.eachCell((cell, index) => {
      const column = columns[index - 1];
      if (numFmts[index - 1] && column.total) cell.numFmt = numFmts[index - 1];
      cell.alignment = { horizontal: index === 1 ? 'left' : column.align };
      cell.border = { top: { style: 'double', color: { argb: 'FF9AA5B1' } }, left: BORDER, bottom: BORDER, right: BORDER };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    });
    totals.commit();
  }

  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber + rows.length, column: columns.length },
  };

  // Repeat the header on every printed page.
  sheet.pageSetup.printTitlesRow = `${headerRowNumber}:${headerRowNumber}`;
  sheet.headerFooter = { oddFooter: `&L${definition.name}&C&P of &N&R${meta.organizationName}` };

  await sheet.commit();
  await workbook.commit();
};

module.exports = { buildXlsx };
