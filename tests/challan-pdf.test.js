const PDFDocument = require('pdfkit');

/**
 * The challan table is drawn as a grid of explicit rectangles at absolute
 * coordinates, so nothing about pdfkit stops a column set from being wider than
 * the paper. It shipped that way once: the rate/tax columns summed to 602pt
 * inside a 535pt frame and the last three columns ran off the right edge of the
 * page. Reading the text back did not catch it, because the text was all
 * correct — it was simply printed past the margin.
 *
 * So the geometry is asserted directly: every rectangle the renderer draws must
 * land inside the page frame, for every combination of format, rate visibility
 * and tax treatment.
 */
const recordBoxes = () => {
  const boxes = [];
  const originals = {};
  // A4 rules the page off with rectangles; the thermal receipt uses horizontal
  // rules instead, so both are recorded as spans to be checked the same way.
  const strings = [];
  for (const method of ['rect', 'moveTo', 'lineTo', 'text']) originals[method] = PDFDocument.prototype[method];

  PDFDocument.prototype.text = function patched(value, ...rest) {
    strings.push(String(value));
    return originals.text.call(this, value, ...rest);
  };

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

  return {
    boxes,
    strings,
    restore: () => Object.assign(PDFDocument.prototype, originals),
  };
};

const { renderChallanPdf } = require('../src/api/dispatch/challanPdf.service');

const line = (name, qty, unit, hsn, gst, ratePaise) => ({
  dispatchedQty: qty,
  product: { name, uom: { code: unit }, hsnCode: { code: hsn, gstRatePercent: gst } },
  salesOrderLine: { ratePaise },
});

const challanFor = (customerState) => ({
  challanNumber: 'DC/2026/00042',
  dispatchDate: new Date('2026-09-04'),
  vehicleNumber: 'OD 02 AB 1234',
  driverName: 'Ramesh Behera',
  factory: {
    name: 'Bhubaneswar Plant',
    address: 'Plot 14, Industrial Estate, Mancheswar',
    city: 'Bhubaneswar',
    state: 'Odisha',
    organization: { name: 'INFIDEEP INFRASTRUCTURE PRIVATE LIMITED', gstin: '21AABCI1234H1Z5' },
  },
  salesOrder: {
    orderNumber: 'SO/2026/00311',
    customer: {
      name: 'Odisha Rural Works Department',
      gstin: '21AAACO7654P1ZQ',
      state: customerState,
      address: 'Unit 5, Sachivalaya Marg',
      city: 'Bhubaneswar',
    },
  },
  lines: [
    // A long product name is the realistic case, not the edge case — precast
    // items carry their spec in the name.
    line('RCC Hume Pipe NP3 600mm dia x 2.5m with collar', '30.0000', 'NOS', '68109990', 18, 354000),
    line('Paver Block M40 80mm Zigzag', '1200.0000', 'SQM', '68101110', 18, 89500),
    line('Rubber Gasket 600mm', '4.0000', 'NOS', '40169390', 18, 21000),
  ],
});

const A4_FRAME = { left: 30, right: 565 };
const THERMAL_FRAME = { left: 10, right: 217 };

describe('delivery challan PDF layout', () => {
  const cases = [
    ['A4 office copy, intra-state (CGST + SGST)', 'Odisha', { format: 'a4', showRates: true }, A4_FRAME],
    ['A4 office copy, inter-state (IGST)', 'West Bengal', { format: 'a4', showRates: true }, A4_FRAME],
    ['A4 driver copy, no rates (BR-07)', 'Odisha', { format: 'a4', showRates: false }, A4_FRAME],
    ['thermal', 'Odisha', { format: 'thermal', showRates: true }, THERMAL_FRAME],
  ];

  it.each(cases)('draws %s entirely inside the page frame', (_label, state, options, frame) => {
    const { boxes, restore } = recordBoxes();
    try {
      const doc = renderChallanPdf(challanFor(state), options);
      doc.end();

      expect(boxes.length).toBeGreaterThan(0);
      const outside = boxes.filter((b) => b.right > frame.right + 0.01 || b.x < frame.left - 0.01);
      expect(outside).toEqual([]);
    } finally {
      restore();
    }
  });

  it('spans the full frame width rather than leaving the table short', () => {
    const { boxes, restore } = recordBoxes();
    try {
      renderChallanPdf(challanFor('Odisha'), { format: 'a4', showRates: true }).end();
      // The columns are meant to fill the frame exactly; a table that stops
      // short looks as broken as one that overruns.
      const widest = Math.max(...boxes.filter((b) => b.width > 0).map((b) => b.right));
      expect(widest).toBeCloseTo(A4_FRAME.right, 1);
    } finally {
      restore();
    }
  });

  it('does not total quantities that are in different units', () => {
    const { strings, restore } = recordBoxes();
    try {
      // 30 NOS + 1200 SQM + 4 NOS is not 1234 of anything.
      renderChallanPdf(challanFor('Odisha'), { format: 'a4', showRates: true }).end();
      expect(strings).toContain('Total');
      expect(strings).not.toContain('1234');
    } finally {
      restore();
    }
  });

  it('totals the quantity, with its unit, when every line shares one', () => {
    const { strings, restore } = recordBoxes();
    try {
      const challan = challanFor('Odisha');
      challan.lines = challan.lines.filter((l) => l.product.uom.code === 'NOS'); // 30 + 4
      renderChallanPdf(challan, { format: 'a4', showRates: true }).end();
      expect(strings).toContain('34 NOS');
    } finally {
      restore();
    }
  });

  it('gives the header enough height that its labels do not run into the first row', () => {
    const { boxes, restore } = recordBoxes();
    try {
      renderChallanPdf(challanFor('Odisha'), { format: 'a4', showRates: true }).end();

      // "CGST %" does not fit on one line in its column, so the header row has
      // to be tall enough for two.
      const cells = boxes.filter((b) => b.width > 0);
      const narrowest = cells.reduce((min, b) => (b.width < min.width ? b : min));
      const headerRow = cells.filter((b) => b.y === narrowest.y && b.height === narrowest.height);
      expect(headerRow.length).toBeGreaterThan(6); // it is a full row of columns
      expect(narrowest.height).toBeGreaterThanOrEqual(24);
    } finally {
      restore();
    }
  });
});
