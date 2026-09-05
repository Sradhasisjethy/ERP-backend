const PDFDocument = require('pdfkit');
const { determineTax, stateCodeFor } = require('../invoicing/taxDetermination');

/**
 * Delivery challan, A4 and 80mm thermal.
 *
 * The money is optional and the caller decides. BR-07 exists because rates
 * leaked to the shop floor and to drivers through exactly this document, so the
 * rate, taxable value and tax columns are drawn only when `showRates` is true —
 * which the controller sets from the requester's VIEW_RATES grant. Everyone
 * gets the same document; the driver's copy simply has no prices on it.
 *
 * Everything printed comes from the record. Rows the data cannot fill are left
 * out rather than shown empty: a blank "E-Way No." on a challan invites someone
 * to write one in by hand.
 */

const A4 = { margin: 30, left: 30, right: 565, fontSize: 8.5, titleSize: 15 };
const THERMAL = { size: [227, 800], margin: 10, left: 10, right: 217, fontSize: 7.5, titleSize: 10 };

/** 30.0000 is scale, not information — a driver reads "30". */
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
  const units = [[10000000, 'Crore'], [100000, 'Lakh'], [1000, 'Thousand']];
  let rest = n;
  for (const [value, label] of units) {
    if (rest >= value) {
      parts.push(`${under1000(Math.floor(rest / value))} ${label}`);
      rest %= value;
    }
  }
  if (rest) parts.push(under1000(rest));
  return `${parts.join(' ')} Rupees Only`.replace(/\s+/g, ' ');
};

/** Every figure the document needs, derived once. */
const buildRows = (challan) => {
  const factory = challan.factory;
  const customer = challan.salesOrder?.customer;

  // Same determination the invoice uses, so a challan and the invoice raised
  // from it never disagree about which tax applies.
  let isInterState = false;
  try {
    ({ isInterState } = determineTax({ factory, customer }));
  } catch {
    // Missing state on either side: fall back to intra-state rather than
    // refusing to print. The invoice is where that has to be got right.
    isInterState = false;
  }

  const rows = (challan.lines || []).map((line, index) => {
    const qty = Number(line.dispatchedQty);
    const ratePaise = Number(line.salesOrderLine?.ratePaise || 0);
    const taxable = Math.round(qty * ratePaise);
    const gstPercent = Number(line.product?.hsnCode?.gstRatePercent || 0);
    const taxPaise = Math.round((taxable * gstPercent) / 100);

    return {
      index: index + 1,
      name: line.product?.name || line.productId,
      hsn: line.product?.hsnCode?.code || '',
      qty: trimQty(line.dispatchedQty),
      unit: line.product?.uom?.code || '',
      ratePaise,
      taxablePaise: taxable,
      gstPercent,
      halfPercent: gstPercent / 2,
      halfTaxPaise: Math.round(taxPaise / 2),
      taxPaise,
      totalPaise: taxable + taxPaise,
    };
  });

  const sum = (key) => rows.reduce((total, row) => total + row[key], 0);

  // A quantity total is only meaningful when every line is in the same unit —
  // 30 NOS + 1200 SQM + 4 NOS is not 1234 of anything, and printing it on a GST
  // document invites someone to reconcile against it.
  const units = new Set(rows.map((row) => row.unit).filter(Boolean));
  const commonUnit = units.size === 1 ? [...units][0] : null;

  return {
    rows,
    isInterState,
    totals: {
      qty: rows.reduce((total, row) => total + Number(row.qty || 0), 0),
      commonUnit,
      mixedUnits: units.size > 1,
      taxablePaise: sum('taxablePaise'),
      taxPaise: sum('taxPaise'),
      totalPaise: sum('totalPaise'),
    },
  };
};

const renderChallanPdf = (challan, { format = 'a4', showRates = false } = {}) =>
  format === 'thermal'
    ? renderThermal(challan, showRates)
    : renderA4(challan, showRates);

// ---------------------------------------------------------------- A4 --------

function renderA4(challan, showRates) {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: A4.margin, bottom: A4.margin, left: A4.margin, right: A4.margin },
  });

  const { rows, isInterState, totals } = buildRows(challan);
  const L = A4.left;
  const R = A4.right;

  doc.fontSize(A4.fontSize);

  let y = A4.margin;
  y = drawLetterhead(doc, challan, y);
  y = drawParties(doc, challan, y, isInterState);
  y = drawTable(doc, rows, totals, y, showRates, isInterState);
  drawFooter(doc, totals, y, showRates, isInterState, challan);

  // The whole document sits inside one frame, drawn last so it is never
  // overrun by a table that grew.
  doc.rect(L, A4.margin, R - L, doc.page.height - A4.margin * 2).lineWidth(0.8).stroke();
  return doc;
}

const cell = (doc, text, x, y, width, options = {}) =>
  doc.text(text === null || text === undefined ? '' : String(text), x + 3, y + 3, {
    width: width - 6,
    align: options.align || 'left',
    lineBreak: options.lineBreak !== false,
  });

const box = (doc, x, y, width, height) => doc.rect(x, y, width, height).lineWidth(0.5).stroke();

function drawLetterhead(doc, challan, y) {
  const L = A4.left;
  const R = A4.right;
  const org = challan.factory?.organization;
  const factory = challan.factory;

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
  cell(doc, 'DELIVERY CHALLAN', L, y + 3, R - L, { align: 'center' });
  doc.font('Helvetica').fontSize(A4.fontSize);

  return y + titleHeight;
}

function drawParties(doc, challan, y, isInterState) {
  const L = A4.left;
  const R = A4.right;
  const mid = L + (R - L) / 2;
  const customer = challan.salesOrder?.customer;

  const height = 92;
  box(doc, L, y, mid - L, height);
  box(doc, mid, y, R - mid, height);

  doc.font('Helvetica-Bold');
  cell(doc, 'Consignee', L, y, mid - L, { align: 'center' });
  cell(doc, 'Challan Details', mid, y, R - mid, { align: 'center' });
  doc.font('Helvetica');

  // Left: who it is going to.
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
  leftY = label('Address', [customer?.address, customer?.city, customer?.state, customer?.pincode].filter(Boolean).join(', '), leftY);
  leftY = label('Phone', customer?.phone, leftY);
  leftY = label('GSTIN', customer?.gstin, leftY);

  const stateCode = customer?.state ? stateCodeFor(customer.state) : null;
  label('Place of Supply', customer?.state ? `${customer.state}${stateCode ? ` (${stateCode})` : ''}` : null, leftY);

  // Right: the movement itself.
  const meta = (text, value, rowY) => {
    if (!value) return rowY;
    doc.font('Helvetica-Bold');
    cell(doc, text, mid, rowY, 95);
    doc.font('Helvetica');
    cell(doc, value, mid + 95, rowY, R - mid - 95);
    return rowY + 12;
  };

  let rightY = y + 14;
  rightY = meta('Challan No.', challan.challanNumber, rightY);
  rightY = meta('Challan Date', challan.dispatchDate, rightY);
  rightY = meta('Order Ref.', challan.salesOrder?.orderNumber, rightY);
  rightY = meta('Vehicle Number', challan.vehicleNumber, rightY);
  rightY = meta('Driver', challan.driverName, rightY);
  meta('Supply Type', isInterState ? 'Inter-state (IGST)' : 'Intra-state (CGST + SGST)', rightY);

  return y + height;
}

/**
 * Column widths differ by what is being shown: without rates the table has room
 * to breathe, so the product name gets the space the money columns would have
 * taken rather than the page carrying a stretch of white.
 */
function columnsFor(showRates, isInterState) {
  if (!showRates) {
    return fitToWidth([
      { key: 'index', label: 'Sr.', width: 28, align: 'center' },
      { key: 'name', label: 'Name of Product', width: 320 },
      { key: 'hsn', label: 'HSN/SAC', width: 90, align: 'center' },
      { key: 'qty', label: 'Qty', width: 60, align: 'right' },
      { key: 'unit', label: 'Unit', width: 37, align: 'center' },
    ]);
  }

  // Quantity and unit share a column once money is on the page — "30 NOS" in
  // one cell rather than two, which buys the width the tax columns need.
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
      { key: 'gstPercent', label: 'IGST %', width: 40, align: 'right' },
      { key: 'gstAmount', label: 'IGST Amt', width: 70, align: 'right' }
    );
  } else {
    base.push(
      { key: 'halfPercent', label: 'CGST %', width: 32, align: 'right' },
      { key: 'halfAmount', label: 'CGST Amt', width: 52, align: 'right' },
      { key: 'halfPercent2', label: 'SGST %', width: 32, align: 'right' },
      { key: 'halfAmount2', label: 'SGST Amt', width: 52, align: 'right' }
    );
  }

  base.push({ key: 'total', label: 'Total', width: 60, align: 'right' });
  return fitToWidth(base);
}

/**
 * Makes the columns add up to the page exactly.
 *
 * Hand-totalled widths are how the table came to be 602pt wide inside a 535pt
 * frame, spilling the last two columns off the edge of the paper. Any
 * difference is absorbed by the product name, which is the one column that can
 * give or take space without becoming unreadable.
 */
function fitToWidth(columns) {
  const available = A4.right - A4.left;
  const total = columns.reduce((sum, column) => sum + column.width, 0);
  const difference = available - total;
  if (difference === 0) return columns;

  return columns.map((column) =>
    column.key === 'name' ? { ...column, width: Math.max(60, column.width + difference) } : column
  );
}

const valueFor = (row, key) => {
  switch (key) {
    case 'qtyUnit': return `${row.qty}${row.unit ? ` ${row.unit}` : ''}`;
    case 'rate': return money(row.ratePaise);
    case 'taxable': return money(row.taxablePaise);
    case 'gstPercent': return row.gstPercent.toFixed(2);
    case 'gstAmount': return money(row.taxPaise);
    case 'halfPercent':
    case 'halfPercent2': return row.halfPercent.toFixed(2);
    case 'halfAmount':
    case 'halfAmount2': return money(row.halfTaxPaise);
    case 'total': return money(row.totalPaise);
    default: return row[key];
  }
};

function drawTable(doc, rows, totals, y, showRates, isInterState) {
  const L = A4.left;
  const columns = columnsFor(showRates, isInterState);

  // Measured, not guessed: "CGST %" does not fit on one line in a 32pt column,
  // and a fixed 22pt header let the wrapped second line run down into the first
  // product row.
  doc.font('Helvetica-Bold');
  const headerHeight = Math.max(
    22,
    ...columns.map((column) => doc.heightOfString(column.label, { width: column.width - 6 }) + 8)
  );
  doc.font('Helvetica');

  const header = (startY) => {
    const height = headerHeight;
    let x = L;
    doc.font('Helvetica-Bold');
    for (const column of columns) {
      box(doc, x, startY, column.width, height);
      cell(doc, column.label, x, startY + 2, column.width, { align: column.align });
      x += column.width;
    }
    doc.font('Helvetica');
    return startY + height;
  };

  y = header(y);

  for (const row of rows) {
    const nameColumn = columns.find((c) => c.key === 'name');
    const height = Math.max(16, doc.heightOfString(row.name, { width: nameColumn.width - 6 }) + 6);

    // A challan can carry many lines — a bundle expands into several — so the
    // table has to be able to continue onto another page.
    if (y + height > doc.page.height - A4.margin - 150) {
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

  // Totals row, aligned under the columns it totals.
  const height = 18;
  let x = L;
  doc.font('Helvetica-Bold');
  for (const column of columns) {
    box(doc, x, y, column.width, height);

    let text = '';
    if (column.key === 'name') text = 'Total';
    else if (column.key === 'qty') text = totals.mixedUnits ? '' : trimQty(totals.qty);
    else if (column.key === 'qtyUnit') {
      text = totals.mixedUnits ? '' : `${trimQty(totals.qty)}${totals.commonUnit ? ` ${totals.commonUnit}` : ''}`;
    }
    else if (column.key === 'taxable') text = money(totals.taxablePaise);
    else if (column.key === 'gstAmount') text = money(totals.taxPaise);
    else if (column.key === 'halfAmount' || column.key === 'halfAmount2') text = money(Math.round(totals.taxPaise / 2));
    else if (column.key === 'total') text = money(totals.totalPaise);

    cell(doc, text, x, y, column.width, { align: column.key === 'name' ? 'right' : column.align });
    x += column.width;
  }
  doc.font('Helvetica');

  return y + height;
}

function drawFooter(doc, totals, y, showRates, isInterState, challan) {
  const L = A4.left;
  const R = A4.right;
  const split = showRates ? L + 320 : L + (R - L) / 2;
  const height = showRates ? 110 : 70;

  box(doc, L, y, split - L, height);
  box(doc, split, y, R - split, height);

  if (showRates) {
    doc.font('Helvetica-Bold');
    cell(doc, 'Total in words', L, y, split - L, { align: 'center' });
    doc.font('Helvetica');
    cell(doc, inWords(totals.totalPaise / 100).toUpperCase(), L, y + 16, split - L, { align: 'center' });

    const summary = [
      ['Taxable Amount', money(totals.taxablePaise)],
      isInterState
        ? ['Add: IGST', money(totals.taxPaise)]
        : ['Add: CGST', money(Math.round(totals.taxPaise / 2))],
      ...(isInterState ? [] : [['Add: SGST', money(Math.round(totals.taxPaise / 2))]]),
      ['Total Tax', money(totals.taxPaise)],
      ['Total Amount After Tax', money(totals.totalPaise)],
    ];

    let rowY = y + 4;
    for (const [label, value] of summary) {
      const isLast = label.startsWith('Total Amount');
      doc.font(isLast ? 'Helvetica-Bold' : 'Helvetica');
      cell(doc, label, split, rowY, (R - split) / 2);
      cell(doc, value, split + (R - split) / 2, rowY, (R - split) / 2, { align: 'right' });
      rowY += 14;
    }
    doc.font('Helvetica');
  } else {
    doc.font('Helvetica-Bold');
    cell(doc, 'Received in good condition', L, y, split - L, { align: 'center' });
    doc.font('Helvetica');
    cell(doc, 'Signature: ____________________________', L, y + 30, split - L, { align: 'center' });

    doc.font('Helvetica-Bold');
    cell(doc, `For ${challan.factory?.organization?.name || challan.factory?.name || ''}`, split, y + 6, R - split, { align: 'center' });
    doc.font('Helvetica');
    cell(doc, 'Authorised Signatory', split, y + 48, R - split, { align: 'center' });
    return;
  }

  y += height;
  const signHeight = 46;
  box(doc, L, y, split - L, signHeight);
  box(doc, split, y, R - split, signHeight);

  cell(doc, 'Received in good condition:', L, y + 4, split - L);
  cell(doc, 'Signature: ____________________', L, y + 24, split - L);

  doc.font('Helvetica-Bold');
  cell(doc, `For ${challan.factory?.organization?.name || ''}`, split, y + 4, R - split, { align: 'center' });
  doc.font('Helvetica');
  cell(doc, 'Authorised Signatory', split, y + 28, R - split, { align: 'center' });
}

// ----------------------------------------------------------- Thermal --------

/**
 * 80mm is too narrow for a bordered table, so the layout is a receipt: each
 * item takes its own lines. Cramming columns into 200pt is what made the
 * original wrap one character per line.
 */
function renderThermal(challan, showRates) {
  const doc = new PDFDocument({
    size: THERMAL.size,
    margins: { top: THERMAL.margin, bottom: THERMAL.margin, left: THERMAL.margin, right: THERMAL.margin },
  });

  const { rows, isInterState, totals } = buildRows(challan);
  const L = THERMAL.left;
  const width = THERMAL.right - L;
  const org = challan.factory?.organization;
  const customer = challan.salesOrder?.customer;

  const line = (text, options = {}) => doc.text(text, L, doc.y, { width, ...options });
  const rule = () => {
    doc.moveTo(L, doc.y + 2).lineTo(THERMAL.right, doc.y + 2).stroke();
    doc.moveDown(0.4);
  };

  doc.font('Helvetica-Bold').fontSize(THERMAL.titleSize);
  line(org?.name || challan.factory?.name || '', { align: 'center' });
  doc.font('Helvetica').fontSize(THERMAL.fontSize);
  if (org?.gstin) line(`GSTIN: ${org.gstin}`, { align: 'center' });
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold');
  line('DELIVERY CHALLAN', { align: 'center' });
  doc.font('Helvetica');
  rule();

  line(`Challan No: ${challan.challanNumber}`);
  line(`Date: ${challan.dispatchDate}`);
  line(`Vehicle: ${challan.vehicleNumber}`);
  if (challan.driverName) line(`Driver: ${challan.driverName}`);
  if (challan.salesOrder?.orderNumber) line(`Order Ref: ${challan.salesOrder.orderNumber}`);
  doc.moveDown(0.3);
  if (customer?.name) line(`To: ${customer.name}`);
  if (customer?.gstin) line(`GSTIN: ${customer.gstin}`);
  rule();

  for (const row of rows) {
    doc.font('Helvetica-Bold');
    line(`${row.index}. ${row.name}`);
    doc.font('Helvetica');
    if (row.hsn) line(`HSN: ${row.hsn}`);

    if (showRates) {
      line(`${row.qty} ${row.unit} x ${money(row.ratePaise)} = ${money(row.taxablePaise)}`, { align: 'right' });
      line(`${isInterState ? 'IGST' : 'GST'} ${row.gstPercent.toFixed(2)}%: ${money(row.taxPaise)}`, { align: 'right' });
      doc.font('Helvetica-Bold');
      line(`Total: ${money(row.totalPaise)}`, { align: 'right' });
      doc.font('Helvetica');
    } else {
      line(`${row.qty} ${row.unit}`.trim(), { align: 'right' });
    }
    doc.moveDown(0.25);
  }

  rule();
  if (showRates) {
    line(`Taxable: ${money(totals.taxablePaise)}`, { align: 'right' });
    line(`Tax: ${money(totals.taxPaise)}`, { align: 'right' });
    doc.font('Helvetica-Bold');
    line(`TOTAL: ${money(totals.totalPaise)}`, { align: 'right' });
    doc.font('Helvetica');
    doc.moveDown(0.3);
    line(inWords(totals.totalPaise / 100).toUpperCase());
  } else {
    doc.font('Helvetica-Bold');
    line(`Total Qty: ${trimQty(totals.qty)}`, { align: 'right' });
    doc.font('Helvetica');
  }

  doc.moveDown(1);
  line('Received in good condition:');
  doc.moveDown(1.5);
  line('Signature: ____________________');

  return doc;
}

module.exports = { renderChallanPdf };
