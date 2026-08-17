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
 * Layout, top to bottom:
 *   1. a title block — organisation, report, period, location, applied filters
 *   2. the summary tiles, as label/value pairs
 *   3. the table: bold header, frozen, auto-filtered, banded, with a totals row
 */

const ACCENT = 'FF1E3A5F';
const HEADER_FILL = 'FFEFF3F8';
const BORDER = { style: 'thin', color: { argb: 'FFD8DEE6' } };

const titleRow = (sheet, text, { size = 11, bold = false, color = 'FF1F2933', span }) => {
  const row = sheet.addRow([text]);
  row.font = { size, bold, color: { argb: color } };
  if (span > 1) sheet.mergeCells(row.number, 1, row.number, span);
  return row;
};

const buildXlsx = async ({ definition, columns, rows, summary, metrics, meta, settings }) => {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = meta.organizationName;
  workbook.created = meta.generatedAt;

  // Excel rejects : \ / ? * [ ] in a sheet name and caps it at 31 characters.
  const sheetName = definition.name.replace(/[:\\/?*[\]]/g, ' ').slice(0, 31);
  const sheet = workbook.addWorksheet(sheetName, {
    views: [{ state: 'frozen', ySplit: 0 }],
    pageSetup: { orientation: columns.length > 8 ? 'landscape' : 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0 },
  });

  const span = Math.max(columns.length, 4);

  titleRow(sheet, meta.organizationName, { size: 16, bold: true, color: ACCENT, span });
  titleRow(sheet, definition.name, { size: 13, bold: true, span });
  if (definition.description) titleRow(sheet, definition.description, { size: 10, color: 'FF52606D', span });
  titleRow(sheet, `Period: ${meta.periodLabel}`, { size: 10, span });
  titleRow(sheet, `Location: ${meta.locationLabel}`, { size: 10, span });
  if (meta.filterLabel) titleRow(sheet, `Filters: ${meta.filterLabel}`, { size: 10, span });
  titleRow(sheet, `All amounts in ${settings.currency}`, { size: 9, color: 'FF52606D', span });
  titleRow(sheet, `Generated ${formatDateTime(meta.generatedAt)} by ${meta.userName}`, { size: 9, color: 'FF52606D', span });
  if (!meta.canViewRates) {
    titleRow(sheet, 'Rate and amount columns are excluded — your role does not permit viewing them.', {
      size: 9,
      bold: true,
      color: 'FFB42318',
      span,
    });
  }
  sheet.addRow([]);

  if (metrics.length) {
    titleRow(sheet, 'Summary', { size: 11, bold: true, span });
    for (const item of metrics) {
      const row = sheet.addRow([item.label, excelValue(summary[item.key], item)]);
      row.getCell(1).font = { size: 10, color: { argb: 'FF52606D' } };
      row.getCell(2).font = { size: 10, bold: true };
      const numFmt = excelNumberFormat(item.type, settings);
      if (numFmt) row.getCell(2).numFmt = numFmt;
      row.getCell(2).alignment = { horizontal: 'right' };
    }
    sheet.addRow([]);
  }

  const headerRow = sheet.addRow(columns.map((c) => c.header));
  headerRow.font = { bold: true, size: 10, color: { argb: ACCENT } };
  headerRow.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
  headerRow.alignment = { vertical: 'middle', wrapText: true };
  headerRow.height = 22;
  headerRow.eachCell((cell, index) => {
    cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
    cell.alignment = { ...cell.alignment, horizontal: columns[index - 1].align };
  });

  const headerRowNumber = headerRow.number;

  for (const [index, record] of rows.entries()) {
    const row = sheet.addRow(columns.map((c) => excelValue(record[c.key], c)));
    row.font = { size: 10 };
    row.eachCell((cell, cellIndex) => {
      const column = columns[cellIndex - 1];
      const numFmt = excelNumberFormat(column.type, settings);
      if (numFmt) cell.numFmt = numFmt;
      cell.alignment = { horizontal: column.align, vertical: 'top', wrapText: column.type === 'text' };
      cell.border = { top: BORDER, left: BORDER, bottom: BORDER, right: BORDER };
      // Banding makes a wide row traceable across the page without a ruler.
      if (index % 2 === 1) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF8FAFC' } };
    });
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
      const numFmt = excelNumberFormat(column.type, settings);
      if (numFmt && column.total) cell.numFmt = numFmt;
      cell.alignment = { horizontal: index === 1 ? 'left' : column.align };
      cell.border = { top: { style: 'double', color: { argb: 'FF9AA5B1' } }, left: BORDER, bottom: BORDER, right: BORDER };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL } };
    });
  }

  // Freeze everything above and including the header, so scrolling a long
  // report keeps both the column names and the context block that says what
  // filters produced it.
  sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  sheet.autoFilter = {
    from: { row: headerRowNumber, column: 1 },
    to: { row: headerRowNumber + rows.length, column: columns.length },
  };

  columns.forEach((column, index) => {
    const sample = rows.slice(0, 200).map((r) => formatValue(r[column.key], column, settings).length);
    const widest = Math.max(column.header.length, ...(sample.length ? sample : [0]));
    sheet.getColumn(index + 1).width = Math.min(Math.max(widest + 3, 10), 46);
  });

  // Repeat the header on every printed page.
  sheet.pageSetup.printTitlesRow = `${headerRowNumber}:${headerRowNumber}`;
  sheet.headerFooter = { oddFooter: `&L${definition.name}&C&P of &N&R${meta.organizationName}` };

  return workbook.xlsx.writeBuffer();
};

module.exports = { buildXlsx };
