const PDFDocument = require('pdfkit');
const { formatValue, formatDateTime } = require('./format');

/**
 * PDF export.
 *
 * The failure modes this is written to avoid are the ones that make a report
 * PDF useless: columns overlapping, text clipped with an ellipsis, the header
 * row vanishing on page 2, and no page numbers. So:
 *
 *   - Cells wrap. Row height is measured from the tallest wrapped cell rather
 *     than assumed, and a row never straddles a page break.
 *   - The header row is redrawn on every page.
 *   - When a report has more columns than can fit legibly even in landscape,
 *     the table is split into column groups rendered one after another, each
 *     repeating the identifying first column. Nothing is dropped or clipped —
 *     the reader gets all of it, in readable type.
 *   - Pages are buffered so the footer can say "Page X of Y".
 *
 * Amounts carry no ₹ symbol on purpose: PDFKit's built-in fonts are
 * WinAnsi-encoded and have no glyph for it. The header states the currency
 * once instead of printing a broken character on every line.
 */

const COLORS = {
  accent: '#1E3A5F',
  muted: '#667085',
  rule: '#D8DEE6',
  band: '#F7F9FC',
  headerBand: '#EFF3F8',
  warn: '#B42318',
  text: '#1F2933',
};

const MARGIN = 32;
const MIN_COLUMN_WIDTH = 46;
const FONT = { regular: 'Helvetica', bold: 'Helvetica-Bold' };

/**
 * Splits columns into groups that each fit the usable width. The first column
 * is repeated at the head of every group after the first so a reader can tell
 * which row they are looking at.
 */
const groupColumns = (columns, usableWidth, scale) => {
  const width = (column) => Math.max(MIN_COLUMN_WIDTH, column.width * scale);
  const groups = [];
  let current = [];
  let currentWidth = 0;
  const anchor = columns[0];
  const anchorWidth = anchor ? width(anchor) : 0;

  for (const column of columns) {
    const columnWidth = width(column);
    const prefixWidth = groups.length === 0 && current.length === 0 ? 0 : current.length === 0 ? anchorWidth : 0;
    if (current.length && currentWidth + columnWidth > usableWidth) {
      groups.push(current);
      current = column === anchor ? [] : [anchor];
      currentWidth = column === anchor ? 0 : anchorWidth;
    }
    current.push(column);
    currentWidth += columnWidth + prefixWidth;
  }
  if (current.length) groups.push(current);
  return groups;
};

/** Distributes the usable width across a group in proportion to declared widths. */
const layoutGroup = (group, usableWidth) => {
  const declared = group.reduce((sum, c) => sum + c.width, 0);
  const raw = group.map((c) => Math.max(MIN_COLUMN_WIDTH, (c.width / declared) * usableWidth));
  const total = raw.reduce((a, b) => a + b, 0);
  // Rescale so the row exactly fills the width even after the minimum kicked in.
  return raw.map((w) => (w / total) * usableWidth);
};

const buildPdf = ({ definition, columns, rows, summary, metrics, meta, settings }, stream) =>
  new Promise((resolve, reject) => {
    // Landscape once a report is wide enough that portrait would squeeze
    // columns below legibility.
    const landscape = columns.length > 6;
    const doc = new PDFDocument({
      size: 'A4',
      layout: landscape ? 'landscape' : 'portrait',
      margin: MARGIN,
      bufferPages: true,
      info: { Title: `${definition.name} — ${meta.organizationName}`, Author: meta.organizationName },
    });

    doc.on('error', reject);
    stream.on('error', reject);
    doc.pipe(stream);

    const pageWidth = doc.page.width;
    const usableWidth = pageWidth - MARGIN * 2;
    const bottomLimit = doc.page.height - MARGIN - 24;

    const fontSize = columns.length > 12 ? 6.5 : columns.length > 9 ? 7 : 7.5;
    // Room for two or three wrapped lines before the group split is preferable.
    const scale = usableWidth / Math.max(columns.reduce((sum, c) => sum + c.width, 0), 1);
    const groups = groupColumns(columns, usableWidth, scale);

    // --- Document header -----------------------------------------------------
    const drawDocumentHeader = () => {
      doc.font(FONT.bold).fontSize(15).fillColor(COLORS.accent).text(meta.organizationName, MARGIN, MARGIN);
      doc.font(FONT.bold).fontSize(11.5).fillColor(COLORS.text).text(definition.name);
      if (definition.description) {
        doc.font(FONT.regular).fontSize(8).fillColor(COLORS.muted).text(definition.description);
      }
      doc.moveDown(0.35);

      const line = (label, value) => {
        doc.font(FONT.bold).fontSize(8).fillColor(COLORS.text).text(`${label}: `, { continued: true });
        doc.font(FONT.regular).fillColor(COLORS.muted).text(value);
      };
      line('Period', meta.periodLabel);
      line('Location', meta.locationLabel);
      if (meta.filterLabel) line('Filters', meta.filterLabel);
      line('Generated', `${formatDateTime(meta.generatedAt)} by ${meta.userName}`);
      doc.font(FONT.regular).fontSize(7.5).fillColor(COLORS.muted).text(`All amounts in ${settings.currency}. ${meta.rowCountLabel}`);
      if (!meta.canViewRates) {
        doc.font(FONT.bold).fontSize(7.5).fillColor(COLORS.warn)
          .text('Rate and amount columns are excluded — your role does not permit viewing them.');
      }
      doc.moveDown(0.5);
      doc.moveTo(MARGIN, doc.y).lineTo(pageWidth - MARGIN, doc.y).strokeColor(COLORS.accent).lineWidth(1).stroke();
      doc.moveDown(0.6);
    };

    // --- Summary tiles -------------------------------------------------------
    const drawSummary = () => {
      if (!metrics.length) return;
      const perRow = Math.min(4, metrics.length);
      const tileWidth = usableWidth / perRow;
      const tileHeight = 30;

      doc.font(FONT.bold).fontSize(9).fillColor(COLORS.text).text('Summary', MARGIN, doc.y);
      doc.moveDown(0.3);

      let index = 0;
      while (index < metrics.length) {
        const slice = metrics.slice(index, index + perRow);
        const top = doc.y;
        slice.forEach((item, position) => {
          const x = MARGIN + position * tileWidth;
          doc.rect(x, top, tileWidth - 4, tileHeight).fillColor(COLORS.band).fill();
          doc.font(FONT.regular).fontSize(6.5).fillColor(COLORS.muted)
            .text(item.label.toUpperCase(), x + 6, top + 5, { width: tileWidth - 16, ellipsis: true });
          doc.font(FONT.bold).fontSize(9).fillColor(COLORS.text)
            .text(formatValue(summary[item.key], item, settings) || '—', x + 6, top + 15, { width: tileWidth - 16, ellipsis: true });
        });
        doc.y = top + tileHeight + 4;
        index += perRow;
      }
      doc.moveDown(0.4);
    };

    // --- Table ---------------------------------------------------------------
    const drawTable = (group) => {
      const widths = layoutGroup(group, usableWidth);
      const cellPadding = 3;

      const measureRow = (values) => {
        doc.font(FONT.regular).fontSize(fontSize);
        return Math.max(
          ...values.map((value, index) =>
            doc.heightOfString(String(value ?? ''), { width: widths[index] - cellPadding * 2 })
          ),
          fontSize + 3
        ) + cellPadding * 2;
      };

      const drawHeader = () => {
        const values = group.map((c) => c.header);
        doc.font(FONT.bold).fontSize(fontSize);
        const height =
          Math.max(
            ...values.map((value, index) => doc.heightOfString(value, { width: widths[index] - cellPadding * 2 })),
            fontSize + 3
          ) + cellPadding * 2;
        const top = doc.y;
        doc.rect(MARGIN, top, usableWidth, height).fillColor(COLORS.headerBand).fill();
        let x = MARGIN;
        group.forEach((column, index) => {
          doc.font(FONT.bold).fontSize(fontSize).fillColor(COLORS.accent).text(column.header, x + cellPadding, top + cellPadding, {
            width: widths[index] - cellPadding * 2,
            align: column.align,
          });
          x += widths[index];
        });
        doc.y = top + height;
        doc.moveTo(MARGIN, doc.y).lineTo(pageWidth - MARGIN, doc.y).strokeColor(COLORS.rule).lineWidth(0.5).stroke();
      };

      const newPage = () => {
        doc.addPage({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: MARGIN });
        doc.y = MARGIN;
        drawHeader();
      };

      drawHeader();

      rows.forEach((record, rowIndex) => {
        const values = group.map((column) => formatValue(record[column.key], column, settings));
        const height = measureRow(values);
        // A row never straddles a page break: if it does not fit, the whole row
        // moves to the next page, under a redrawn header.
        if (doc.y + height > bottomLimit) newPage();

        const top = doc.y;
        if (rowIndex % 2 === 1) doc.rect(MARGIN, top, usableWidth, height).fillColor(COLORS.band).fill();

        let x = MARGIN;
        group.forEach((column, index) => {
          doc.font(FONT.regular).fontSize(fontSize).fillColor(COLORS.text).text(values[index], x + cellPadding, top + cellPadding, {
            width: widths[index] - cellPadding * 2,
            align: column.align,
          });
          x += widths[index];
        });
        doc.y = top + height;
      });

      const totalColumns = group.filter((c) => c.total);
      if (totalColumns.length && rows.length) {
        const values = group.map((column, index) => {
          if (index === 0) return 'TOTAL';
          if (!column.total) return '';
          const sum = rows.reduce((acc, record) => acc + (Number(record[column.key]) || 0), 0);
          return formatValue(sum, column, settings);
        });
        const height = measureRow(values);
        if (doc.y + height > bottomLimit) newPage();
        const top = doc.y;
        doc.rect(MARGIN, top, usableWidth, height).fillColor(COLORS.headerBand).fill();
        let x = MARGIN;
        group.forEach((column, index) => {
          doc.font(FONT.bold).fontSize(fontSize).fillColor(COLORS.text).text(values[index], x + cellPadding, top + cellPadding, {
            width: widths[index] - cellPadding * 2,
            align: index === 0 ? 'left' : column.align,
          });
          x += widths[index];
        });
        doc.y = top + height;
      }
    };

    drawDocumentHeader();
    drawSummary();

    if (!columns.length) {
      doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted).text('This report has no tabular detail — see the summary above.');
    } else if (!rows.length) {
      doc.font(FONT.regular).fontSize(9).fillColor(COLORS.muted).text('No data matched the selected filters.');
    } else {
      groups.forEach((group, index) => {
        if (index > 0) {
          doc.addPage({ size: 'A4', layout: landscape ? 'landscape' : 'portrait', margin: MARGIN });
          doc.y = MARGIN;
          doc.font(FONT.bold).fontSize(9).fillColor(COLORS.accent)
            .text(`${definition.name} — columns ${index + 1} of ${groups.length}`, MARGIN, MARGIN);
          doc.moveDown(0.4);
        }
        drawTable(group);
      });
    }

    // --- Footer on every page, once the total is known -----------------------
    const range = doc.bufferedPageRange();
    for (let index = 0; index < range.count; index += 1) {
      doc.switchToPage(range.start + index);
      const y = doc.page.height - MARGIN - 12;
      doc.moveTo(MARGIN, y - 4).lineTo(doc.page.width - MARGIN, y - 4).strokeColor(COLORS.rule).lineWidth(0.5).stroke();
      doc.font(FONT.regular).fontSize(7).fillColor(COLORS.muted);
      doc.text(`${meta.organizationName} · ${definition.name}`, MARGIN, y, { width: usableWidth / 2, align: 'left' });
      doc.text(`Generated by ${meta.userName} · Page ${index + 1} of ${range.count}`, MARGIN + usableWidth / 2, y, {
        width: usableWidth / 2,
        align: 'right',
      });
    }

    doc.on('end', resolve);
    doc.end();
  });

module.exports = { buildPdf };
