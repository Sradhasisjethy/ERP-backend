const PDFDocument = require('pdfkit');

/**
 * The shop-floor job card for a confirmed production plan.
 *
 * Deliberately carries no rates or costs. A production sheet is handed to the
 * batching crew, and BR-07 exists precisely because rate information used to
 * leak to the shop floor through printed paperwork — the same reason the
 * delivery challan omits them.
 *
 * The material figures are the mix design exploded to the confirmed quantity,
 * i.e. what *should* be issued. What was actually consumed is recorded against
 * the production entry afterwards, and any difference is a variance the
 * supervisor has to explain (BR-09).
 */
const renderProductionSheetPdf = (plan, lines) => {
  const doc = new PDFDocument({ size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 } });

  doc.fontSize(18).text('PRODUCTION SHEET', { align: 'center' });
  doc.moveDown(0.4);
  doc.fontSize(11);
  doc.text(`Plan No: ${plan.planNumber || plan.id}`);
  doc.text(`Plan Date: ${plan.planDate}`);
  doc.text(`Status: ${plan.status}`);
  doc.moveDown(0.8);

  lines.forEach((line, index) => {
    // Keep a job card on one page per item where possible: a crew works from
    // one sheet at one machine, and a run split across a page break is how the
    // second half gets missed.
    if (index > 0) doc.addPage();

    doc.font('Helvetica-Bold').fontSize(13).text(`${index + 1}. ${line.product?.name || 'Product'}`);
    doc.font('Helvetica').fontSize(11);
    doc.text(`Product Code: ${line.product?.code || '—'}`);
    doc.text(`Quantity to produce: ${Number(line.confirmedQty ?? line.requiredQty)}`);
    if (line.producedQty !== undefined) {
      doc.text(`Already produced: ${Number(line.producedQty)}`);
      doc.text(`Remaining: ${Number(line.remainingQty)}`);
    }
    doc.moveDown(0.6);

    if (!line.mixDesign) {
      doc.fillColor('red').text('No mix design is effective for this product — cannot batch.').fillColor('black');
      doc.moveDown(0.6);
      return;
    }

    doc.font('Helvetica-Bold').text(`Mix Design: ${line.mixDesign.name} (v${line.mixDesign.version})`);
    doc.moveDown(0.4);

    const col = { sn: 40, material: 75, perUnit: 300, total: 400, issued: 480 };
    doc.text('#', col.sn, doc.y);
    const headerY = doc.y - doc.currentLineHeight();
    doc.text('Material', col.material, headerY);
    doc.text('Per Unit', col.perUnit, headerY);
    doc.text('Total', col.total, headerY);
    doc.text('Issued', col.issued, headerY);
    doc.moveDown(0.3);
    doc.moveTo(40, doc.y).lineTo(555, doc.y).stroke();
    doc.moveDown(0.3);

    doc.font('Helvetica');
    (line.mixDesign.lines || []).forEach((m, i) => {
      const y = doc.y;
      const qty = Number(line.confirmedQty ?? line.requiredQty);
      doc.text(String(i + 1), col.sn, y);
      doc.text(m.rawMaterial?.name || '—', col.material, y);
      doc.text(String(Number(m.quantityPerUnit)), col.perUnit, y);
      doc.text(String(Number((Number(m.quantityPerUnit) * qty).toFixed(4))), col.total, y);
      // Left blank on purpose: the storekeeper writes the actual issue here,
      // and it is keyed back in as the consumption figure.
      doc.text('__________', col.issued, y);
      doc.moveDown(0.5);
    });

    doc.moveDown(1.2);
    doc.text('Batched by: ______________________', 40, doc.y);
    doc.moveDown(0.8);
    doc.text('Supervisor: ______________________', 40, doc.y);
  });

  return doc;
};

module.exports = { renderProductionSheetPdf };
