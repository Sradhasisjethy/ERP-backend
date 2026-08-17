const PDFDocument = require('pdfkit');

/**
 * M18: thermal (80mm) / A4 printing. Deliberately does not print any rate or
 * amount — a delivery challan travels with the driver, and BR-07/pain-point
 * P7 exist specifically because rate information used to leak to the shop
 * floor and drivers via exactly this kind of document.
 */
const renderChallanPdf = (challan, { format = 'a4' } = {}) => {
  const isThermal = format === 'thermal';
  const doc = new PDFDocument(
    isThermal
      ? { size: [227, 700], margins: { top: 10, bottom: 10, left: 10, right: 10 } } // 80mm width
      : { size: 'A4', margins: { top: 40, bottom: 40, left: 40, right: 40 } }
  );

  const fontSize = isThermal ? 8 : 11;
  const titleSize = isThermal ? 11 : 18;

  doc.fontSize(titleSize).text('DELIVERY CHALLAN', { align: 'center' });
  doc.moveDown(0.5);
  doc.fontSize(fontSize);
  doc.text(`Challan No: ${challan.challanNumber}`);
  doc.text(`Date: ${challan.dispatchDate}`);
  doc.text(`Vehicle No: ${challan.vehicleNumber}`);
  if (challan.driverName) doc.text(`Driver: ${challan.driverName}`);
  doc.text(`Order Ref: ${challan.salesOrder?.orderNumber || ''}`);
  doc.moveDown(0.5);
  doc.text(`Customer: ${challan.salesOrder?.customer?.name || ''}`);
  if (!isThermal && challan.salesOrder?.customer?.address) {
    doc.text(challan.salesOrder.customer.address);
  }
  doc.moveDown(0.75);

  doc.font('Helvetica-Bold');
  if (isThermal) {
    doc.text('Item', { continued: true, width: 140 });
    doc.text('Qty', { align: 'right' });
  } else {
    doc.text('#', 40, doc.y, { continued: true, width: 30 });
    doc.text('Product', { continued: true, width: 380 });
    doc.text('Qty', { align: 'right' });
  }
  doc.font('Helvetica');
  doc.moveTo(doc.x, doc.y + 2).lineTo(isThermal ? 217 : 555, doc.y + 2).stroke();
  doc.moveDown(0.3);

  (challan.lines || []).forEach((line, index) => {
    if (isThermal) {
      doc.text(`${line.product?.name || line.productId}`, { continued: true, width: 140 });
      doc.text(String(line.dispatchedQty), { align: 'right' });
    } else {
      doc.text(String(index + 1), 40, doc.y, { continued: true, width: 30 });
      doc.text(line.product?.name || line.productId, { continued: true, width: 380 });
      doc.text(String(line.dispatchedQty), { align: 'right' });
    }
  });

  doc.moveDown(1.5);
  doc.text('Received in good condition:', { align: isThermal ? 'left' : 'left' });
  doc.moveDown(2);
  doc.text('Signature: ______________________');

  return doc;
};

module.exports = { renderChallanPdf };
