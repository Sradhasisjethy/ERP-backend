const PDFDocument = require('pdfkit');

/**
 * The invoice table is drawn as a grid of rectangles at absolute coordinates,
 * so nothing about pdfkit stops a column set from being wider than the paper.
 * That shipped once on the delivery challan — the rate/tax columns summed to
 * 602pt inside a 535pt frame and ran off the right edge — and reading the text
 * back did not catch it, because the text was correct, just printed past the
 * margin. So the geometry is asserted directly here from the start.
 */
const record = () => {
  const boxes = [];
  const strings = [];
  const originals = {};
  for (const method of ['rect', 'moveTo', 'lineTo', 'text']) originals[method] = PDFDocument.prototype[method];

  PDFDocument.prototype.rect = function patched(x, y, width, height) {
    boxes.push({ x, y, width, height, right: x + width });
    return originals.rect.call(this, x, y, width, height);
  };
  for (const method of ['moveTo', 'lineTo']) {
    PDFDocument.prototype[method] = function patched(x, y) {
      boxes.push({ x, y, width: 0, height: 0, right: x });
      return originals[method].call(this, x, y);
    };
  }
  PDFDocument.prototype.text = function patched(value, ...rest) {
    strings.push(String(value));
    return originals.text.call(this, value, ...rest);
  };

  return { boxes, strings, restore: () => Object.assign(PDFDocument.prototype, originals) };
};

const { renderInvoicePdf } = require('../src/api/invoicing/invoicePdf.service');

const FRAME = { left: 30, right: 565 };

/** An 18% invoice for 30 NOS at 3,540.00 and 1200 SQM at 895.00. */
const invoiceFor = ({ interState = false, status = 'POSTED', roundOffPaise = 0 } = {}) => {
  const lines = [
    { name: 'RCC Hume Pipe NP3 600mm dia x 2.5m with collar', qty: '30.0000', unit: 'NOS', hsn: '68109990', rate: 354000, taxable: 10620000 },
    { name: 'Paver Block M40 80mm Zigzag', qty: '1200.0000', unit: 'SQM', hsn: '68101110', rate: 89500, taxable: 107400000 },
  ].map((l) => {
    const tax = Math.round(l.taxable * 0.18);
    return {
      productId: l.name,
      hsnCode: l.hsn,
      quantity: l.qty,
      ratePaise: l.rate,
      gstRatePercent: 18,
      taxableAmountPaise: l.taxable,
      cgstPaise: interState ? 0 : Math.round(tax / 2),
      sgstPaise: interState ? 0 : Math.round(tax / 2),
      igstPaise: interState ? tax : 0,
      lineTotalPaise: l.taxable + tax,
      product: { name: l.name, uom: { code: l.unit } },
    };
  });

  const subtotal = lines.reduce((s, l) => s + l.taxableAmountPaise, 0);
  const cgst = lines.reduce((s, l) => s + l.cgstPaise, 0);
  const sgst = lines.reduce((s, l) => s + l.sgstPaise, 0);
  const igst = lines.reduce((s, l) => s + l.igstPaise, 0);

  return {
    invoiceNumber: 'INV/BBSR/0001',
    invoiceDate: '2026-09-06',
    status,
    placeOfSupplyCode: interState ? '19' : '21',
    supplierStateCode: '21',
    subtotalPaise: subtotal,
    cgstPaise: cgst,
    sgstPaise: sgst,
    igstPaise: igst,
    roundOffPaise,
    totalPaise: subtotal + cgst + sgst + igst + roundOffPaise,
    factory: {
      name: 'Bhubaneswar Plant',
      address: 'Plot 14, Industrial Estate, Mancheswar',
      city: 'Bhubaneswar',
      state: 'Odisha',
      organization: { name: 'INFIDEEP PRECAST PRIVATE LIMITED', gstin: '21AABCI1234M1Z5' },
    },
    customer: {
      name: 'Odisha Rural Works Department',
      gstin: interState ? '19AAACO7654P1ZQ' : '21AAACO7654P1ZQ',
      state: interState ? 'West Bengal' : 'Odisha',
      address: 'Unit 5, Sachivalaya Marg',
      city: 'Bhubaneswar',
    },
    challanLinks: [
      { deliveryChallan: { challanNumber: 'DC/BBSR/0001' } },
      { deliveryChallan: { challanNumber: 'DC/BBSR/0002' } },
    ],
    lines,
  };
};

describe('tax invoice PDF', () => {
  const run = (invoice) => {
    const r = record();
    try {
      renderInvoicePdf(invoice).end();
      return { boxes: r.boxes, strings: r.strings };
    } finally {
      r.restore();
    }
  };

  it.each([
    ['intra-state (CGST + SGST)', { interState: false }],
    ['inter-state (IGST)', { interState: true }],
    ['cancelled', { status: 'CANCELLED' }],
    ['with a round-off line', { roundOffPaise: 40 }],
  ])('draws %s entirely inside the page frame', (_label, options) => {
    const { boxes } = run(invoiceFor(options));
    expect(boxes.length).toBeGreaterThan(0);
    expect(boxes.filter((b) => b.right > FRAME.right + 0.01 || b.x < FRAME.left - 0.01)).toEqual([]);
  });

  it('spans the full frame width rather than leaving the table short', () => {
    const { boxes } = run(invoiceFor());
    expect(Math.max(...boxes.filter((b) => b.width > 0).map((b) => b.right))).toBeCloseTo(FRAME.right, 1);
  });

  it('shows CGST and SGST for an intra-state supply, and no IGST column', () => {
    const { strings } = run(invoiceFor({ interState: false }));
    expect(strings).toContain('CGST Amt');
    expect(strings).toContain('SGST Amt');
    expect(strings).not.toContain('IGST Amt');
  });

  it('shows IGST for an inter-state supply, and no CGST/SGST columns', () => {
    const { strings } = run(invoiceFor({ interState: true }));
    expect(strings).toContain('IGST Amt');
    expect(strings).not.toContain('CGST Amt');
  });

  it('prints the figures stored on the invoice rather than recomputing them', () => {
    // The invoice was filed with these amounts; a later master-data edit must
    // not change what a reprint says.
    const invoice = invoiceFor();
    invoice.totalPaise = 999900;
    invoice.subtotalPaise = 800000;
    const { strings } = run(invoice);
    expect(strings).toContain('9,999.00');
    expect(strings).toContain('8,000.00');
  });

  it('carries every challan it consolidates', () => {
    const { strings } = run(invoiceFor());
    expect(strings).toContain('DC/BBSR/0001, DC/BBSR/0002');
  });

  it('states the statutory particulars', () => {
    const { strings } = run(invoiceFor());
    expect(strings).toContain('TAX INVOICE');
    expect(strings).toContain('INV/BBSR/0001');
    expect(strings).toContain('21AABCI1234M1Z5'.replace(/^/, 'GSTIN: ')); // supplier
    expect(strings).toContain('21AAACO7654P1ZQ'); // recipient
    expect(strings).toContain('Odisha (21)'); // place of supply
    expect(strings).toContain('No'); // reverse charge
    expect(strings).toContain('Authorised Signatory');
  });

  it('resolves the place of supply from the invoice, not the customer address', () => {
    // placeOfSupplyCode is snapshotted precisely so a later address edit cannot
    // change a filed invoice.
    const invoice = invoiceFor();
    invoice.placeOfSupplyCode = '19';
    invoice.customer.state = 'Odisha';
    const { strings } = run(invoice);
    expect(strings).toContain('West Bengal (19)');
  });

  it('marks a cancelled invoice on its face', () => {
    const { strings } = run(invoiceFor({ status: 'CANCELLED' }));
    // The number is preserved and the document stays printable for the audit
    // trail, so it has to say what it is.
    expect(strings).toContain('CANCELLED');
  });

  it('leaves a posted invoice unmarked', () => {
    const { strings } = run(invoiceFor({ status: 'POSTED' }));
    expect(strings).not.toContain('CANCELLED');
  });

  it('omits the round-off row when there is nothing to round', () => {
    expect(run(invoiceFor({ roundOffPaise: 0 })).strings).not.toContain('Round Off');
    expect(run(invoiceFor({ roundOffPaise: 40 })).strings).toContain('Round Off');
  });

  it('does not total quantities that are in different units', () => {
    // 30 NOS + 1200 SQM is not 1230 of anything.
    expect(run(invoiceFor()).strings).not.toContain('1230');
  });
});
