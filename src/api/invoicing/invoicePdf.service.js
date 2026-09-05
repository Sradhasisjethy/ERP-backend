const PDFDocument = require('pdfkit');
const { STATE_CODES, stateCodeFor } = require('./taxDetermination');

/**
 * GST tax invoice, A4.
 *
 * Deliberately a separate renderer from the delivery challan rather than a
 * shared one with flags. The two documents look alike today, but a challan is
 * an internal movement note while this is the statutory document a buyer claims
 * input credit against — they answer to different rules and will keep drifting
 * apart. A shared renderer threaded with `if (isInvoice)` would be harder to
 * read than the box-drawing it saves.
 *
 * Every figure is read from the invoice record, never recomputed. The tax was
 * determined once at invoice time and the amounts, the place of supply and the
 * HSN are all snapshotted on the row (see salesInvoice.model.js) precisely so
 * that a later edit to a customer address or an HSN master cannot change what a
 * filed invoice says. Recomputing here would defeat that.
 */

const A4 = { margin: 30, left: 30, right: 565, fontSize: 8.5, titleSize: 15 };

/**
 * State name for a place-of-supply code, e.g. "21" -> "Odisha (21)".
 *
 * STATE_CODES maps lowercase names to codes and carries aliases (orissa/odisha,
 * pondicherry/puducherry), so the reverse map keeps the first name listed for
 * each code — the canonical one.
 */
const STATE_NAMES = Object.entries(STATE_CODES).reduce((map, [name, code]) => {
  if (!map[code]) map[code] = name;
  return map;
}, {});

const MINOR_WORDS = new Set(['and', 'of']);
const titleCase = (name) =>
  String(name)
    .split(' ')
    .map((word, index) =>
      index > 0 && MINOR_WORDS.has(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)
    )
    .join(' ');

/**
 * The code is what was snapshotted on the invoice, so it decides. The customer's
 * own spelling of the state is preferred for display when it agrees with that
 * code — "Odisha" as they wrote it rather than a canonical form — and the
 * lookup table is the fallback when it does not, which is exactly the case
 * where the customer address has been edited since the invoice was filed.
 */
const placeOfSupplyLabel = (code, customerState) => {
  if (!code) return customerState || null;
  const name =
    customerState && stateCodeFor(customerState) === code
      ? customerState
      : STATE_NAMES[code] && titleCase(STATE_NAMES[code]);
  return name ? `${name} (${code})` : code;
};

/** 30.0000 is scale, not information. */
const trimQty = (value) => {
  const text = String(value ?? '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text;
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
};

const money = (paise) =>
  (Number(paise || 0) / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const ONES = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
  'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** Indian numbering: the total is stated in words on the face of the document. */
const inWords = (rupees) => {
  const n = Math.round(Number(rupees || 0));
  if (n === 0) return 'Zero Rupees Only';

  const under1000 = (v) => {
    if (v < 20) return ONES[v];
    if (v < 100) return `${TENS[Math.floor(v / 10)]}${v % 10 ? ` ${ONES[v % 10]}` : ''}`;
    return `${ONES[Math.floor(v / 100)]} Hundred${v % 100 ? ` and ${under1000(v % 100)}` : ''}`;
  };

  const parts = [];
  let rest = n;
  for (const [value, label] of [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']]) {
    if (rest >= value) {
      parts.push(`${under1000(Math.floor(rest / value))} ${label}`);
      rest %= value;
    }
  }
  if (rest) parts.push(under1000(rest));
  return `${parts.join(' ')} Rupees Only`.replace(/\s+/g, ' ');
};

/**
 * Which tax heads this invoice actually carries.
 *
 * Taken from the stored amounts first: they are what was filed. The state codes
 * are only consulted for a fully exempt invoice, where every tax column is zero
 * and the amounts cannot say which head *would* have applied.
 */
const isInterStateInvoice = (invoice) => {
  if (Number(invoice.igstPaise) > 0) return true;
  if (Number(invoice.cgstPaise) > 0 || Number(invoice.sgstPaise) > 0) return false;
  const supplier = invoice.supplierStateCode;
  const place = invoice.placeOfSupplyCode;
  return Boolean(supplier && place && supplier !== place);
};

const buildRows = (invoice) =>
  (invoice.lines || []).map((line, index) => ({
    index: index + 1,
    name: line.product?.name || line.productId,
    hsn: line.hsnCode || line.product?.hsnCode?.code || '',
    qty: trimQty(line.quantity),
    unit: line.product?.uom?.code || '',
    ratePaise: Number(line.ratePaise || 0),
    taxablePaise: Number(line.taxableAmountPaise || 0),
    gstPercent: Number(line.gstRatePercent || 0),
    cgstPaise: Number(line.cgstPaise || 0),
    sgstPaise: Number(line.sgstPaise || 0),
    igstPaise: Number(line.igstPaise || 0),
    totalPaise: Number(line.lineTotalPaise || 0),
  }));

const renderInvoicePdf = (invoice) => {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: A4.margin, bottom: A4.margin, left: A4.margin, right: A4.margin },
  });

  const rows = buildRows(invoice);
  const isInterState = isInterStateInvoice(invoice);

  doc.fontSize(A4.fontSize);

  let y = A4.margin;
  y = drawLetterhead(doc, invoice, y);
  y = drawParties(doc, invoice, y);
  y = drawTable(doc, invoice, rows, y, isInterState);
  drawFooter(doc, invoice, y, isInterState);

  // The frame is drawn last so a table that grew cannot overrun it.
  doc.rect(A4.left, A4.margin, A4.right - A4.left, doc.page.height - A4.margin * 2).lineWidth(0.8).stroke();

  // A cancelled invoice must never be mistaken for a live one. The number is
  // preserved (BR-33) and the document stays printable — for the audit trail —
  // but it says so across its face.
  if (invoice.status === 'CANCELLED') drawCancelledWatermark(doc);

  return doc;
};

const cell = (doc, text, x, y, width, options = {}) =>
  doc.text(text === null || text === undefined ? '' : String(text), x + 3, y + 3, {
    width: width - 6,
    align: options.align || 'left',
    lineBreak: options.lineBreak !== false,
  });

const box = (doc, x, y, width, height) => doc.rect(x, y, width, height).lineWidth(0.5).stroke();

function drawLetterhead(doc, invoice, y) {
  const L = A4.left;
  const R = A4.right;
  const factory = invoice.factory;
  const org = factory?.organization;

  const height = 62;
  box(doc, L, y, R - L, height);

  doc.font('Helvetica-Bold').fontSize(A4.titleSize);
  cell(doc, org?.name || factory?.name || '', L, y + 2, R - L, { align: 'center' });

  doc.font('Helvetica').fontSize(A4.fontSize);
  const address = [factory?.address, factory?.city, factory?.state].filter(Boolean).join(', ');
  if (address) cell(doc, address, L, y + 24, R - L, { align: 'center' });
  if (org?.gstin) {
    doc.font('Helvetica-Bold');
    cell(doc, `GSTIN: ${org.gstin}`, L, y + 38, R - L, { align: 'center' });
    doc.font('Helvetica');
  }

  y += height;

  const titleHeight = 20;
  box(doc, L, y, R - L, titleHeight);
  doc.font('Helvetica-Bold').fontSize(12);
  cell(doc, 'TAX INVOICE', L, y + 3, R - L, { align: 'center' });
  doc.font('Helvetica').fontSize(A4.fontSize);

  return y + titleHeight;
}

function drawParties(doc, invoice, y) {
  const L = A4.left;
  const R = A4.right;
  const mid = L + (R - L) / 2;
  const customer = invoice.customer;

  const height = 92;
  box(doc, L, y, mid - L, height);
  box(doc, mid, y, R - mid, height);

  doc.font('Helvetica-Bold');
  cell(doc, 'Billed To', L, y, mid - L, { align: 'center' });
  cell(doc, 'Invoice Details', mid, y, R - mid, { align: 'center' });
  doc.font('Helvetica');

  const label = (text, value, rowY) => {
    if (!value) return rowY;
    doc.font('Helvetica-Bold');
    cell(doc, text, L, rowY, 70);
    doc.font('Helvetica');
    cell(doc, value, L + 70, rowY, mid - L - 70);
    return rowY + Math.max(11, doc.heightOfString(String(value), { width: mid - L - 76 }));
  };

  let leftY = y + 14;
  leftY = label('M/S', customer?.name, leftY);
  leftY = label(
    'Address',
    [customer?.address, customer?.city, customer?.state, customer?.pincode].filter(Boolean).join(', '),
    leftY
  );
  leftY = label('Phone', customer?.phone, leftY);
  leftY = label('GSTIN', customer?.gstin, leftY);
  // Snapshotted on the invoice, not read from the customer's current address.
  label('Place of Supply', placeOfSupplyLabel(invoice.placeOfSupplyCode, customer?.state), leftY);

  const meta = (text, value, rowY) => {
    if (!value) return rowY;
    doc.font('Helvetica-Bold');
    cell(doc, text, mid, rowY, 95);
    doc.font('Helvetica');
    cell(doc, value, mid + 95, rowY, R - mid - 95);
    return rowY + 12;
  };

  // One invoice can consolidate several challans (BR-15), so the references are
  // listed rather than assumed to be a single number.
  const challanNumbers = (invoice.challanLinks || [])
    .map((link) => link.deliveryChallan?.challanNumber)
    .filter(Boolean)
    .join(', ');

  let rightY = y + 14;
  rightY = meta('Invoice No.', invoice.invoiceNumber, rightY);
  rightY = meta('Invoice Date', invoice.invoiceDate, rightY);
  rightY = meta('Challan Ref.', challanNumbers, rightY);
  rightY = meta('Reverse Charge', 'No', rightY);
  if (invoice.status === 'CANCELLED') {
    doc.font('Helvetica-Bold');
    meta('Status', 'CANCELLED', rightY);
    doc.font('Helvetica');
  }

  return y + height;
}

/**
 * Makes the columns add up to the page exactly.
 *
 * Hand-totalled widths are how the challan table came to be 602pt wide inside a
 * 535pt frame, spilling its last columns off the paper. Any difference is
 * absorbed by the product name, the one column that can give or take space
 * without becoming unreadable.
 */
function fitToWidth(columns) {
  const available = A4.right - A4.left;
  const difference = available - columns.reduce((sum, column) => sum + column.width, 0);
  if (difference === 0) return columns;
  return columns.map((column) =>
    column.key === 'name' ? { ...column, width: Math.max(60, column.width + difference) } : column
  );
}

function columnsFor(isInterState) {
  // Quantity and unit share a cell ("30 NOS") to buy the width the tax columns
  // need. There is no rate-free variant: an invoice without money is not one.
  const base = [
    { key: 'index', label: 'Sr.', width: 18, align: 'center' },
    { key: 'name', label: 'Name of Product', width: 104 },
    { key: 'hsn', label: 'HSN/SAC', width: 44, align: 'center' },
    { key: 'qtyUnit', label: 'Qty', width: 54, align: 'right' },
    { key: 'rate', label: 'Rate', width: 50, align: 'right' },
    { key: 'taxable', label: 'Taxable', width: 56, align: 'right' },
  ];

  if (isInterState) {
    base.push(
      { key: 'igstPercent', label: 'IGST %', width: 40, align: 'right' },
      { key: 'igstAmount', label: 'IGST Amt', width: 70, align: 'right' }
    );
  } else {
    base.push(
      { key: 'cgstPercent', label: 'CGST %', width: 32, align: 'right' },
      { key: 'cgstAmount', label: 'CGST Amt', width: 52, align: 'right' },
      { key: 'sgstPercent', label: 'SGST %', width: 32, align: 'right' },
      { key: 'sgstAmount', label: 'SGST Amt', width: 52, align: 'right' }
    );
  }

  base.push({ key: 'total', label: 'Total', width: 60, align: 'right' });
  return fitToWidth(base);
}

const valueFor = (row, key) => {
  switch (key) {
    case 'qtyUnit': return `${row.qty}${row.unit ? ` ${row.unit}` : ''}`;
    case 'rate': return money(row.ratePaise);
    case 'taxable': return money(row.taxablePaise);
    case 'igstPercent': return row.gstPercent.toFixed(2);
    case 'igstAmount': return money(row.igstPaise);
    case 'cgstPercent':
    case 'sgstPercent': return (row.gstPercent / 2).toFixed(2);
    case 'cgstAmount': return money(row.cgstPaise);
    case 'sgstAmount': return money(row.sgstPaise);
    case 'total': return money(row.totalPaise);
    default: return row[key];
  }
};

function drawTable(doc, invoice, rows, y, isInterState) {
  const L = A4.left;
  const columns = columnsFor(isInterState);

  // Measured, not guessed: "CGST %" does not fit on one line in a 32pt column,
  // and a fixed header height lets the wrapped second line run into the first
  // product row.
  doc.font('Helvetica-Bold');
  const headerHeight = Math.max(
    22,
    ...columns.map((column) => doc.heightOfString(column.label, { width: column.width - 6 }) + 8)
  );
  doc.font('Helvetica');

  const header = (startY) => {
    let x = L;
    doc.font('Helvetica-Bold');
    for (const column of columns) {
      box(doc, x, startY, column.width, headerHeight);
      cell(doc, column.label, x, startY + 2, column.width, { align: column.align });
      x += column.width;
    }
    doc.font('Helvetica');
    return startY + headerHeight;
  };

  y = header(y);

  const nameColumn = columns.find((c) => c.key === 'name');
  for (const row of rows) {
    const height = Math.max(16, doc.heightOfString(row.name, { width: nameColumn.width - 6 }) + 6);

    // A consolidated invoice can carry many lines, so the table continues onto
    // another page rather than running off this one.
    if (y + height > doc.page.height - A4.margin - 170) {
      doc.addPage();
      y = header(A4.margin);
    }

    let x = L;
    for (const column of columns) {
      box(doc, x, y, column.width, height);
      cell(doc, valueFor(row, column.key), x, y, column.width, { align: column.align });
      x += column.width;
    }
    y += height;
  }

  // Totals row. Quantities are only summed when every line shares a unit —
  // 30 NOS + 1200 SQM is not 1230 of anything.
  const units = new Set(rows.map((r) => r.unit).filter(Boolean));
  const commonUnit = units.size === 1 ? [...units][0] : null;
  const totalQty = rows.reduce((sum, r) => sum + Number(r.qty || 0), 0);

  const height = 18;
  let x = L;
  doc.font('Helvetica-Bold');
  for (const column of columns) {
    box(doc, x, y, column.width, height);

    let text = '';
    if (column.key === 'name') text = 'Total';
    else if (column.key === 'qtyUnit') {
      text = units.size > 1 ? '' : `${trimQty(totalQty)}${commonUnit ? ` ${commonUnit}` : ''}`;
    } else if (column.key === 'taxable') text = money(invoice.subtotalPaise);
    else if (column.key === 'igstAmount') text = money(invoice.igstPaise);
    else if (column.key === 'cgstAmount') text = money(invoice.cgstPaise);
    else if (column.key === 'sgstAmount') text = money(invoice.sgstPaise);
    else if (column.key === 'total') text = money(invoice.totalPaise);

    cell(doc, text, x, y, column.width, { align: column.key === 'name' ? 'right' : column.align });
    x += column.width;
  }
  doc.font('Helvetica');

  return y + height;
}

function drawFooter(doc, invoice, y, isInterState) {
  const L = A4.left;
  const R = A4.right;
  const split = L + 320;

  // Round-off is only a line when there is one to show.
  const roundOff = Number(invoice.roundOffPaise || 0);
  const summary = [
    ['Taxable Amount', money(invoice.subtotalPaise)],
    ...(isInterState
      ? [['Add: IGST', money(invoice.igstPaise)]]
      : [['Add: CGST', money(invoice.cgstPaise)], ['Add: SGST', money(invoice.sgstPaise)]]),
    ...(roundOff ? [['Round Off', money(roundOff)]] : []),
    ['Total Amount After Tax', money(invoice.totalPaise)],
  ];

  const height = Math.max(110, summary.length * 14 + 12);
  box(doc, L, y, split - L, height);
  box(doc, split, y, R - split, height);

  doc.font('Helvetica-Bold');
  cell(doc, 'Total in words', L, y, split - L, { align: 'center' });
  doc.font('Helvetica');
  cell(doc, inWords(Number(invoice.totalPaise) / 100).toUpperCase(), L, y + 16, split - L, { align: 'center' });
  cell(doc, 'Tax payable on reverse charge: No', L, y + height - 26, split - L, { align: 'center' });

  let rowY = y + 4;
  for (const [label, value] of summary) {
    const isLast = label.startsWith('Total Amount');
    doc.font(isLast ? 'Helvetica-Bold' : 'Helvetica');
    cell(doc, label, split, rowY, (R - split) / 2);
    cell(doc, value, split + (R - split) / 2, rowY, (R - split) / 2, { align: 'right' });
    rowY += 14;
  }
  doc.font('Helvetica');

  y += height;
  const signHeight = 46;
  box(doc, L, y, split - L, signHeight);
  box(doc, split, y, R - split, signHeight);

  cell(doc, 'Certified that the particulars given above are true.', L, y + 4, split - L);
  cell(doc, 'Received by: ____________________', L, y + 24, split - L);

  doc.font('Helvetica-Bold');
  cell(doc, `For ${invoice.factory?.organization?.name || invoice.factory?.name || ''}`, split, y + 4, R - split, { align: 'center' });
  doc.font('Helvetica');
  cell(doc, 'Authorised Signatory', split, y + 28, R - split, { align: 'center' });
}

function drawCancelledWatermark(doc) {
  const { width, height } = doc.page;
  doc.save();
  doc.rotate(-30, { origin: [width / 2, height / 2] });
  doc.font('Helvetica-Bold').fontSize(90).fillColor('#d0d0d0');
  doc.text('CANCELLED', 0, height / 2 - 60, { width, align: 'center' });
  doc.restore();
  doc.font('Helvetica').fontSize(A4.fontSize).fillColor('black');
}

module.exports = { renderInvoicePdf };
