const PDFDocument = require('pdfkit');
const { formatDate } = require('../../utils/dateDisplay');

/**
 * Professional Production Job Card / Batching Sheet (A4 Portrait).
 *
 * Implements BR-07: Strictly carries no rates, prices, or costs so shop-floor
 * batching crews work with quantities and formulas without financial leak.
 *
 * Handles both populated production lines and zero-line plans with a clean,
 * formal layout suitable for industrial precast / plant batching environments.
 */

const A4 = { margin: 30, left: 30, right: 565, fontSize: 8.5, titleSize: 14 };

const trimQty = (value) => {
  const text = String(value ?? '');
  if (!/^-?\d+(\.\d+)?$/.test(text)) return text;
  return text.includes('.') ? text.replace(/\.?0+$/, '') : text;
};

const box = (doc, x, y, width, height, options = {}) => {
  if (options.fill) {
    doc.save().rect(x, y, width, height).fill(options.fill).restore();
  }
  doc.rect(x, y, width, height).lineWidth(options.lineWidth || 0.5);
  if (options.strokeColor) {
    doc.strokeColor(options.strokeColor);
  } else {
    doc.strokeColor('#000000');
  }
  doc.stroke();
  doc.strokeColor('#000000');
};

const cell = (doc, text, x, y, width, options = {}) =>
  doc.text(text === null || text === undefined ? '' : String(text), x + 4, y + 3, {
    width: width - 8,
    align: options.align || 'left',
    lineBreak: options.lineBreak !== false,
  });

const formatPlanRef = (plan) => {
  if (plan.planNumber) return plan.planNumber;
  const shortId = String(plan.id || '').slice(0, 8).toUpperCase();
  const dateStr = String(plan.planDate || '').replace(/-/g, '');
  return `PP-${dateStr}-${shortId}`;
};

const drawOuterFrame = (doc) => {
  doc.save();
  doc.rect(A4.left, A4.margin, A4.right - A4.left, doc.page.height - A4.margin * 2)
    .lineWidth(1)
    .strokeColor('#1e293b')
    .stroke();
  doc.restore();
};

const drawHeader = (doc, plan, display, pageIndex, totalPages) => {
  const L = A4.left;
  const R = A4.right;
  const W = R - L;
  let y = A4.margin;

  const org = plan.factory?.organization;
  const factory = plan.factory;

  // 1. Company & Plant Banner
  const bannerHeight = 52;
  box(doc, L, y, W, bannerHeight, { fill: '#f8fafc', strokeColor: '#cbd5e1' });

  doc.font('Helvetica-Bold').fontSize(13).fillColor('#0f172a');
  cell(doc, org?.name || 'INFIDEEP ERP - MANUFACTURING', L, y + 4, W, { align: 'center' });

  doc.font('Helvetica').fontSize(8.5).fillColor('#475569');
  const factoryText = factory
    ? `Plant: ${factory.name} (${factory.code || 'MAIN'}) · ${[factory.address, factory.city, factory.state].filter(Boolean).join(', ')}`
    : 'Primary Production Facility';
  cell(doc, factoryText, L, y + 22, W, { align: 'center' });

  if (org?.gstin) {
    doc.fontSize(8);
    cell(doc, `GSTIN: ${org.gstin}`, L, y + 36, W, { align: 'center' });
  }

  y += bannerHeight;

  // 2. Title Stripe
  const titleHeight = 22;
  box(doc, L, y, W, titleHeight, { fill: '#1e293b' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#ffffff');
  cell(doc, 'PRODUCTION JOB CARD / BATCHING SHEET', L, y + 5, W, { align: 'center' });
  doc.fillColor('#000000');

  y += titleHeight;

  // 3. Metadata 2-Column Grid
  const metaHeight = 54;
  const halfW = W / 2;
  box(doc, L, y, halfW, metaHeight, { strokeColor: '#cbd5e1' });
  box(doc, L + halfW, y, halfW, metaHeight, { strokeColor: '#cbd5e1' });

  const planRef = formatPlanRef(plan);
  const formattedDate = formatDate(plan.planDate, display) || plan.planDate;

  // Left Column
  doc.fontSize(8.5);
  doc.font('Helvetica-Bold').text('Plan Reference: ', L + 8, y + 6, { continued: true });
  doc.font('Helvetica').text(planRef);

  doc.font('Helvetica-Bold').text('Scheduled Date: ', L + 8, y + 21, { continued: true });
  doc.font('Helvetica').text(formattedDate);

  doc.font('Helvetica-Bold').text('Plan Status: ', L + 8, y + 36, { continued: true });
  doc.font('Helvetica-Bold').fillColor(plan.status === 'CONFIRMED' ? '#166534' : '#854d0e').text(plan.status);
  doc.fillColor('#000000');

  // Right Column
  doc.font('Helvetica-Bold').text('Production Facility: ', L + halfW + 8, y + 6, { continued: true });
  doc.font('Helvetica').text(factory?.name || 'Default Plant');

  doc.font('Helvetica-Bold').text('Shift / Operations: ', L + halfW + 8, y + 21, { continued: true });
  doc.font('Helvetica').text('General Production Shift');

  doc.font('Helvetica-Bold').text('Printed On: ', L + halfW + 8, y + 36, { continued: true });
  doc.font('Helvetica').text(`${formatDate(new Date(), display)} (System Auto-Generated)`);

  y += metaHeight;
  return y;
};

const drawFooterSignatures = (doc) => {
  const L = A4.left;
  const R = A4.right;
  const W = R - L;
  const halfW = W / 2;
  const sigHeight = 38;
  const sigY = doc.page.height - A4.margin - sigHeight - 14;

  // Clean 2-column signature footer (Operator & Supervisor)
  box(doc, L, sigY, halfW, sigHeight, { fill: '#f8fafc', strokeColor: '#cbd5e1' });
  box(doc, L + halfW, sigY, halfW, sigHeight, { fill: '#f8fafc', strokeColor: '#cbd5e1' });

  // Left: Operator / Batching Crew
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#334155');
  cell(doc, 'Batched & Cast By (Operator):', L + 8, sigY + 5, halfW - 16);
  doc.font('Helvetica').fontSize(7.5).fillColor('#64748b');
  cell(doc, 'Signature: __________________________   Date: ____________', L + 8, sigY + 22, halfW - 16);

  // Right: Plant Incharge / QC Supervisor
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#334155');
  cell(doc, 'Verified & Approved (Supervisor / QC):', L + halfW + 8, sigY + 5, halfW - 16);
  doc.font('Helvetica').fontSize(7.5).fillColor('#64748b');
  cell(doc, 'Signature: __________________________   Date: ____________', L + halfW + 8, sigY + 22, halfW - 16);

  // Bottom Compliance Notice
  doc.font('Helvetica').fontSize(6.8).fillColor('#64748b');
  const bottomY = doc.page.height - A4.margin - 10;
  doc.text(
    'INFIDEEP ERP · Confidential Production Job Card · BR-07 Rate-Restricted Document',
    L + 8,
    bottomY,
    { width: W - 16, align: 'center' }
  );
  doc.fillColor('#000000');
};

const drawEmptyPlanState = (doc, startY, plan) => {
  const L = A4.left;
  const R = A4.right;
  const W = R - L;
  const boxHeight = 170;
  const cardY = startY + 24;

  box(doc, L + 20, cardY, W - 40, boxHeight, { fill: '#f1f5f9', strokeColor: '#cbd5e1' });

  doc.font('Helvetica-Bold').fontSize(12).fillColor('#334155');
  cell(doc, 'NO PRODUCTION LINES SCHEDULED ON THIS PLAN', L + 20, cardY + 20, W - 40, { align: 'center' });

  doc.font('Helvetica').fontSize(9).fillColor('#475569');
  const explanation =
    'This production plan contains 0 item lines. At the time this proposal was evaluated, ' +
    'open sales order quantities were already fully covered by current uncommitted factory inventory, ' +
    'or no pending production shortfall was found for this date.';
  doc.text(explanation, L + 40, cardY + 48, { width: W - 80, align: 'center', lineGap: 3 });

  // Key details pill
  const pillY = cardY + 105;
  box(doc, L + 100, pillY, W - 200, 36, { fill: '#ffffff', strokeColor: '#94a3b8' });
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0f172a');
  cell(doc, `Plan ID: ${plan.id}`, L + 100, pillY + 5, W - 200, { align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#64748b');
  cell(doc, `Status: ${plan.status} · Target Net Shortfall: 0.00 Units`, L + 100, pillY + 19, W - 200, { align: 'center' });

  doc.fillColor('#000000');
};

const drawItemJobCard = (doc, line, index, startY) => {
  const L = A4.left;
  const R = A4.right;
  const W = R - L;
  let y = startY + 10;

  const targetQty = Number(line.confirmedQty ?? line.requiredQty ?? 0);
  const producedQty = Number(line.producedQty || 0);
  const remainingQty = Number(line.remainingQty ?? Math.max(0, targetQty - producedQty));
  const uomName = line.product?.uom?.code || line.product?.uom?.name || 'Units';

  // 1. Finished Product Header Card
  const prodCardHeight = 44;
  box(doc, L, y, W, prodCardHeight, { fill: '#f8fafc', strokeColor: '#cbd5e1' });

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#0f172a');
  cell(doc, `Line #${index + 1}: ${line.product?.name || 'Finished Product'}`, L + 8, y + 5, W * 0.65);

  doc.font('Helvetica').fontSize(8).fillColor('#475569');
  cell(doc, `Product Code: ${line.product?.code || '—'}  |  Curing Period: ${line.product?.curingDays ?? 0} Days`, L + 8, y + 24, W * 0.65);

  // Target KPI Badge on the right
  const kpiW = 150;
  const kpiX = R - kpiW - 8;
  box(doc, kpiX, y + 4, kpiW, 36, { fill: '#e2e8f0', strokeColor: '#94a3b8' });
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#1e293b');
  cell(doc, `TARGET: ${trimQty(targetQty)} ${uomName}`, kpiX, y + 7, kpiW, { align: 'center' });
  doc.font('Helvetica').fontSize(7.5).fillColor('#475569');
  cell(doc, `Produced: ${trimQty(producedQty)} | Rem: ${trimQty(remainingQty)}`, kpiX, y + 21, kpiW, { align: 'center' });

  y += prodCardHeight + 8;

  // 2. Mix Design / Recipe Banner
  const mixDesign = line.mixDesign;
  if (!mixDesign) {
    const warnHeight = 40;
    box(doc, L, y, W, warnHeight, { fill: '#fef2f2', strokeColor: '#f87171' });
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#991b1b');
    cell(doc, 'WARNING: NO ACTIVE MIX DESIGN / RECIPE EFFECTIVE ON PLAN DATE', L, y + 8, W, { align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#b91c1c');
    cell(doc, 'Raw materials cannot be exploded automatically. Please verify mix design masters.', L, y + 22, W, { align: 'center' });
    doc.fillColor('#000000');
    return y + warnHeight + 12;
  }

  // Active Mix Design Title
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#1e293b');
  doc.text(`Batch Formulation: ${mixDesign.name} (Version ${mixDesign.version || '1.0'})`, L + 2, y);
  y += 14;

  // 3. Raw Materials Table
  // Columns: # (25), Raw Material (180), UoM (40), Per Unit (70), Total Required (80), Store Issued (75), Verified (65) = 535
  const cols = [
    { id: 'sn', label: '#', w: 25, align: 'center' },
    { id: 'material', label: 'Raw Material / Ingredient', w: 180, align: 'left' },
    { id: 'uom', label: 'Unit', w: 40, align: 'center' },
    { id: 'perUnit', label: 'Per Unit Qty', w: 70, align: 'right' },
    { id: 'total', label: 'Total Batch Req.', w: 80, align: 'right' },
    { id: 'issued', label: 'Store Issue (Act.)', w: 75, align: 'center' },
    { id: 'check', label: 'Batch Tick', w: 65, align: 'center' },
  ];

  const headerH = 18;
  let curX = L;
  cols.forEach((col) => {
    box(doc, curX, y, col.w, headerH, { fill: '#334155', strokeColor: '#1e293b' });
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#ffffff');
    cell(doc, col.label, curX, y + 3, col.w, { align: col.align });
    curX += col.w;
  });
  y += headerH;

  const rowH = 20;
  (mixDesign.lines || []).forEach((m, mIdx) => {
    const qtyPerUnit = Number(m.quantityPerUnit || 0);
    const totalRequired = Number((qtyPerUnit * targetQty).toFixed(4));
    const matUom = m.uom?.code || m.rawMaterial?.uom?.code || '—';
    const isAlt = mIdx % 2 === 1;

    curX = L;
    // Row background
    box(doc, curX, y, W, rowH, { fill: isAlt ? '#f8fafc' : '#ffffff', strokeColor: '#cbd5e1' });

    cols.forEach((col) => {
      box(doc, curX, y, col.w, rowH, { strokeColor: '#e2e8f0' });
      doc.font('Helvetica').fontSize(8).fillColor('#0f172a');

      if (col.id === 'sn') {
        cell(doc, String(mIdx + 1), curX, y + 4, col.w, { align: 'center' });
      } else if (col.id === 'material') {
        cell(doc, m.rawMaterial?.name || 'Raw Material', curX, y + 4, col.w, { align: 'left' });
      } else if (col.id === 'uom') {
        cell(doc, matUom, curX, y + 4, col.w, { align: 'center' });
      } else if (col.id === 'perUnit') {
        cell(doc, trimQty(qtyPerUnit), curX, y + 4, col.w, { align: 'right' });
      } else if (col.id === 'total') {
        doc.font('Helvetica-Bold');
        cell(doc, trimQty(totalRequired), curX, y + 4, col.w, { align: 'right' });
        doc.font('Helvetica');
      } else if (col.id === 'issued') {
        // A neat write-in box for storekeeper issue
        box(doc, curX + 6, y + 3, col.w - 12, rowH - 6, { strokeColor: '#94a3b8' });
      } else if (col.id === 'check') {
        // A square checkbox for batch operator
        box(doc, curX + (col.w - 12) / 2, y + 4, 12, 12, { strokeColor: '#94a3b8' });
      }

      curX += col.w;
    });

    y += rowH;
  });

  y += 10;

  // 4. Shop Floor Batch Execution Log
  const logH = 34;
  box(doc, L, y, W, logH, { fill: '#f8fafc', strokeColor: '#cbd5e1' });
  doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#475569');
  cell(doc, 'SHOP FLOOR BATCHING RECORD:', L + 6, y + 3, W);

  doc.font('Helvetica').fontSize(7.5).fillColor('#334155');
  const quarterW = W / 4;
  cell(doc, 'Mixer / Pan ID: [                 ]', L + 6, y + 16, quarterW);
  cell(doc, 'Bed / Mould No: [                 ]', L + quarterW, y + 16, quarterW);
  cell(doc, 'W/C Ratio / Slump: [            ]', L + quarterW * 2, y + 16, quarterW);
  cell(doc, 'Start / End Time: [             ]', L + quarterW * 3, y + 16, quarterW);

  y += logH + 10;
  return y;
};

const renderProductionSheetPdf = (plan, lines = [], { display = {} } = {}) => {
  const doc = new PDFDocument({
    size: 'A4',
    margins: { top: A4.margin, bottom: A4.margin, left: A4.margin, right: A4.margin },
    autoFirstPage: false,
  });

  if (!lines || lines.length === 0) {
    // Single page empty plan state
    doc.addPage();
    drawOuterFrame(doc);
    const startY = drawHeader(doc, plan, display, 1, 1);
    drawEmptyPlanState(doc, startY, plan);
    drawFooterSignatures(doc);
    return doc;
  }

  // Multi-item plan: each line item gets its dedicated clean batching sheet
  lines.forEach((line, index) => {
    doc.addPage();
    drawOuterFrame(doc);
    const startY = drawHeader(doc, plan, display, index + 1, lines.length);
    drawItemJobCard(doc, line, index, startY);
    drawFooterSignatures(doc);
  });

  return doc;
};

module.exports = { renderProductionSheetPdf };
