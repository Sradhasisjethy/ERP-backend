const PDFDocument = require('pdfkit');

/**
 * FR-M27-2/3 — report export.
 *
 * The rule that shapes this: for a user without finance.view_rates the export
 * must contain **no value columns at all**, not columns full of blanks
 * (FR-M27-3). A blanked column still tells the reader a number exists and how
 * many rows have one; dropping the column is what BR-27 actually asks for.
 * `buildColumns` is therefore the single place that decides which columns
 * exist, and both formats render from that same list.
 */

const MONEY_SUFFIX = /Paise$/;

/** Drops money columns entirely when the caller may not see rates. */
const buildColumns = (columns, { canViewRates }) =>
  columns.filter((col) => (canViewRates ? true : !(col.money || MONEY_SUFFIX.test(col.key))));

const formatCell = (value, col) => {
  if (value === null || value === undefined) return '';
  if (col.money || MONEY_SUFFIX.test(col.key)) return (Number(value) / 100).toFixed(2);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
};

const csvEscape = (value) => {
  const s = String(value ?? '');
  // A leading =, +, - or @ makes Excel treat the cell as a formula, which is a
  // real injection vector when the data came from user input. Prefixing with a
  // quote neutralises it without changing what the reader sees.
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return /[",\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/**
 * Excel-readable CSV. Chosen over a real .xlsx writer deliberately: xlsx needs
 * a heavy dependency, and every tool the client uses opens CSV. The BOM makes
 * Excel read it as UTF-8 so Indian names and ₹ don't mojibake.
 */
const toCsv = ({ title, filters, columns, rows, canViewRates }) => {
  const cols = buildColumns(columns, { canViewRates });
  const lines = [];

  if (title) lines.push(csvEscape(title));
  if (filters && Object.keys(filters).length) {
    lines.push(csvEscape(`Filters: ${Object.entries(filters).map(([k, v]) => `${k}=${v}`).join('; ')}`));
  }
  if (!canViewRates) lines.push(csvEscape('Rate and value columns are not included for your role.'));
  if (lines.length) lines.push('');

  lines.push(cols.map((c) => csvEscape(c.header)).join(','));
  for (const row of rows) {
    lines.push(cols.map((c) => csvEscape(formatCell(row[c.key], c))).join(','));
  }

  return `﻿${lines.join('\n')}`;
};

/** Streams a landscape A4 PDF of the same column set. */
const toPdf = ({ title, filters, columns, rows, canViewRates, company }, stream) => {
  const cols = buildColumns(columns, { canViewRates });
  const doc = new PDFDocument({ size: 'A4', layout: 'landscape', margin: 36 });
  doc.pipe(stream);

  if (company?.name) doc.fontSize(14).text(company.name, { align: 'left' });
  if (company?.gstin) doc.fontSize(8).fillColor('#555').text(`GSTIN: ${company.gstin}`);
  doc.moveDown(0.3).fillColor('#000').fontSize(12).text(title || 'Report');

  if (filters && Object.keys(filters).length) {
    doc.fontSize(8).fillColor('#555').text(Object.entries(filters).map(([k, v]) => `${k}: ${v}`).join('   '));
  }
  if (!canViewRates) {
    doc.fontSize(8).fillColor('#a00').text('Rate and value columns are not included for your role.');
  }
  doc.fillColor('#000').moveDown(0.5);

  const usable = doc.page.width - doc.options.margin * 2;
  const colWidth = usable / Math.max(cols.length, 1);
  const rowHeight = 16;

  const drawHeader = () => {
    const y = doc.y;
    doc.fontSize(8).font('Helvetica-Bold');
    cols.forEach((c, i) => {
      doc.text(c.header, doc.options.margin + i * colWidth, y, { width: colWidth - 4, ellipsis: true });
    });
    doc.font('Helvetica').moveDown(0.6);
    doc.moveTo(doc.options.margin, doc.y).lineTo(doc.page.width - doc.options.margin, doc.y).stroke();
    doc.moveDown(0.2);
  };

  drawHeader();

  for (const row of rows) {
    if (doc.y + rowHeight > doc.page.height - doc.options.margin) {
      doc.addPage({ size: 'A4', layout: 'landscape', margin: 36 });
      drawHeader();
    }
    const y = doc.y;
    doc.fontSize(8);
    cols.forEach((c, i) => {
      doc.text(formatCell(row[c.key], c), doc.options.margin + i * colWidth, y, { width: colWidth - 4, ellipsis: true });
    });
    doc.y = y + rowHeight;
  }

  doc.fontSize(7).fillColor('#777').text(
    `Generated ${new Date().toLocaleString('en-IN')} — ${rows.length} row(s)`,
    doc.options.margin,
    doc.page.height - doc.options.margin - 10
  );

  doc.end();
};

module.exports = { toCsv, toPdf, buildColumns };
