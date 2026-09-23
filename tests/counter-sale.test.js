const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode,
  MixDesign, MixDesignLine, Party, StockLot,
} = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;
let factory;
let rawMaterial;
let finishedGood;
let pricedGood;
let vendor;
let b2bCustomer;
// Captured at seed time. Reading these back off a scoped model later returns a
// row with no tenantId, because there is no CLS tenant outside a request.
let tenantId;
let uom;
let hsn;
// Seeded by the bundle describe below and reused by the override tests after
// it, so they share one rule rather than each building their own.
let bundled;
let includedAccessory;
let optionalAccessory;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const produce = async (productId, goodQty, productionDate = '2026-08-15') =>
  request(app).post('/api/v1/production/entries').set('Cookie', adminCookie)
    .send({ factoryId: factory.id, productId, productionDate, goodQty });

const onHand = async (productId) => {
  const lots = await StockLot.findAll({ where: { factoryId: factory.id, productId } });
  return lots.reduce((sum, l) => sum + Number(l.qtyAvailable), 0);
};

const counterSale = (body) =>
  request(app).post('/api/v1/retail/counter-sales').set('Cookie', adminCookie).send(body);

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-counter', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@counter-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  // Factory in Odisha; a walk-in with no state declared is presumed local, so
  // these sales are intra-state and must split CGST+SGST.
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Counter Factory', code: 'CTR-FAC', state: 'Odisha' });

  uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-CTR' });
  hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast concrete', gstRatePercent: 18 });

  rawMaterial = await Product.create({ tenantId, uomId: uom.id, name: 'Cement Ctr', code: 'RM-CEM-CTR', productType: 'RAW_MATERIAL', curingDays: 0 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Paver Ctr', code: 'FG-PAVER-CTR', productType: 'FINISHED_GOOD', curingDays: 0 });
  // Carries its own selling price so an unpriced line can be exercised.
  pricedGood = await Product.create({
    tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Kerb Ctr', code: 'FG-KERB-CTR',
    productType: 'FINISHED_GOOD', curingDays: 0, sellingPricePaise: 31000,
  });

  for (const product of [finishedGood, pricedGood]) {
    const mix = await MixDesign.create({ tenantId, productId: product.id, name: 'Mix v1', version: 1, isActive: true });
    await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });
  }

  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Ctr Vendor' });
  b2bCustomer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Ctr Contractor', state: 'Odisha', gstin: '21AABCI1234M1Z5' });

  adminCookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@counter-test.co', password: PASSWORD }),
    'accessToken'
  );

  await request(app).post('/api/v1/purchasing/receipts').set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-10', lines: [{ productId: rawMaterial.id, receivedQty: 5000, ratePaise: 5000 }] });
});

afterAll(async () => {
  await sequelize.close();
});

describe('B2C counter sale — the happy path', () => {
  let sale;
  let stockBefore;

  beforeAll(async () => {
    await produce(finishedGood.id, 100);
    stockBefore = await onHand(finishedGood.id);

    // 10 @ Rs 1000 = Rs 10,000 taxable, 18% GST = Rs 1,800, total Rs 11,800.
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-20',
      customer: { name: 'Ramesh Sahoo', phone: '9861000001' },
      lines: [{ productId: finishedGood.id, quantity: 10, ratePaise: 100000 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: 1180000 }] },
    });
    expect(res.status).toBe(201);
    sale = res.body.data;
  });

  it('raises a POSTED tax invoice marked as a counter sale', () => {
    expect(sale.invoice.status).toBe('POSTED');
    expect(sale.invoice.saleChannel).toBe('COUNTER');
    expect(sale.invoice.invoiceNumber).toMatch(/INV/);
  });

  it('splits GST as CGST+SGST for a local walk-in', () => {
    expect(Number(sale.invoice.subtotalPaise)).toBe(1000000);
    expect(Number(sale.invoice.cgstPaise)).toBe(90000);
    expect(Number(sale.invoice.sgstPaise)).toBe(90000);
    expect(Number(sale.invoice.igstPaise)).toBe(0);
    expect(Number(sale.invoice.totalPaise)).toBe(1180000);
  });

  it('issues the stock in the same step', async () => {
    expect(await onHand(finishedGood.id)).toBe(stockBefore - 10);
  });

  it('collects the money and leaves nothing outstanding', async () => {
    expect(sale.receipt).toBeTruthy();
    expect(Number(sale.receipt.totalAmountPaise)).toBe(1180000);

    const list = await request(app)
      .get(`/api/v1/invoices?page=1&limit=50&customerPartyId=${sale.customer.id}`)
      .set('Cookie', adminCookie);
    const row = list.body.data.rows.find((i) => i.id === sale.invoice.id);
    expect(Number(row.outstandingPaise)).toBe(0);
  });

  it('creates the walk-in as a customer with no GSTIN', () => {
    expect(sale.customer.partyType).toBe('CUSTOMER');
    expect(sale.customer.name).toBe('Ramesh Sahoo');
    expect(sale.customer.gstin).toBeFalsy();
    // No state was given, so the factory's own state stands in — the
    // conservative default, since it yields an intra-state supply.
    expect(sale.customer.state).toBe('Odisha');
  });

  it('recognises the same walk-in by phone on a later visit', async () => {
    const again = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-21',
      customer: { name: 'Ramesh Sahoo', phone: '9861000001' },
      lines: [{ productId: finishedGood.id, quantity: 1, ratePaise: 100000 }],
      payment: { modes: [{ mode: 'UPI', amountPaise: 118000 }] },
    });
    expect(again.status).toBe(201);
    // The same party, not a second Ramesh Sahoo — otherwise every repeat
    // customer fragments into a new ledger and the party master fills up.
    expect(again.body.data.customer.id).toBe(sale.customer.id);
  });

  it('lists under counter sales, and not as a B2B invoice', async () => {
    const res = await request(app).get('/api/v1/retail/counter-sales?page=1&limit=50').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const ids = res.body.data.rows.map((i) => i.id);
    expect(ids).toContain(sale.invoice.id);
    expect(res.body.data.rows.every((i) => i.saleChannel === 'COUNTER')).toBe(true);
  });

  it('reaches GSTR-1 in the B2C section, because the buyer has no GSTIN', async () => {
    const res = await request(app)
      .get(`/api/v1/gstr/gstr1?factoryId=${factory.id}&fromDate=2026-08-01&toDate=2026-08-31`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const b2cNumbers = res.body.data.b2c.map((r) => r.invoiceNumber);
    const b2bNumbers = res.body.data.b2b.map((r) => r.invoiceNumber);
    expect(b2cNumbers).toContain(sale.invoice.invoiceNumber);
    expect(b2bNumbers).not.toContain(sale.invoice.invoiceNumber);
  });
});

describe('Pricing', () => {
  it("falls back to the product's selling price when no rate is given", async () => {
    await produce(pricedGood.id, 50);
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-22',
      customer: { name: 'Unpriced Buyer', phone: '9861000002' },
      lines: [{ productId: pricedGood.id, quantity: 2 }],
      // 62000 taxable + 11160 GST = 73160, rounded to the rupee = 73200.
      payment: { modes: [{ mode: 'CASH', amountPaise: 73200 }] },
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.data.invoice.subtotalPaise)).toBe(62000);
  });

  it('refuses to sell an unpriced product rather than invoicing it at zero', async () => {
    const freebie = await Product.create({
      tenantId, uomId: uom.id, hsnId: hsn.id,
      name: 'Unpriced Ctr', code: 'FG-UNPRICED-CTR', productType: 'FINISHED_GOOD', curingDays: 0,
    });
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-22',
      customer: { name: 'Nobody', phone: '9861000003' },
      lines: [{ productId: freebie.id, quantity: 1 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no price could be found/i);
  });
});

describe('Stock protection', () => {
  it('will not sell stock reserved against a confirmed B2B order', async () => {
    // A clean product so the arithmetic is unambiguous.
    const contested = await Product.create({
      tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Contested Ctr', code: 'FG-CONTESTED-CTR',
      productType: 'FINISHED_GOOD', curingDays: 0, sellingPricePaise: 10000,
    });
    const mix = await MixDesign.create({ tenantId, productId: contested.id, name: 'Mix v1', version: 1, isActive: true });
    await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });

    await produce(contested.id, 30);

    // A contractor books 25 of the 30 and confirms, which holds them.
    const so = await request(app).post('/api/v1/sales/orders').set('Cookie', adminCookie)
      .send({
        factoryId: factory.id, customerPartyId: b2bCustomer.id, orderDate: '2026-08-23',
        lines: [{ productId: contested.id, orderedQty: 25, ratePaise: 10000 }],
      });
    expect(so.status).toBe(201);
    const confirmed = await request(app).put(`/api/v1/sales/orders/${so.body.data.id}/confirm`).set('Cookie', adminCookie);
    expect(confirmed.status).toBe(200);

    // 30 on hand, 25 reserved -> only 5 may be sold across the counter.
    const overreach = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-24',
      customer: { name: 'Walk In Six', phone: '9861000006' },
      lines: [{ productId: contested.id, quantity: 6 }],
    });
    expect(overreach.status).toBe(400);
    expect(overreach.body.message).toMatch(/free stock/i);
    expect(overreach.body.message).toMatch(/reserved/i);

    // And the five that are genuinely free still sell.
    const within = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-24',
      customer: { name: 'Walk In Five', phone: '9861000005' },
      lines: [{ productId: contested.id, quantity: 5 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: Math.round(5 * 10000 * 1.18) }] },
    });
    expect(within.status).toBe(201);
  });

  it('refuses a quantity that exceeds what physically exists', async () => {
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-25',
      customer: { name: 'Greedy Buyer', phone: '9861000004' },
      lines: [{ productId: finishedGood.id, quantity: 99999, ratePaise: 100 }],
    });
    expect(res.status).toBe(400);
  });
});

describe('Payment rules', () => {
  it('rejects a payment that does not settle the invoice in full', async () => {
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-26',
      customer: { name: 'Short Payer', phone: '9861000007' },
      lines: [{ productId: finishedGood.id, quantity: 1, ratePaise: 100000 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: 100000 }] }, // ignores the GST
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not match the invoice total/i);
  });

  it('leaves the stock alone when the payment is refused', async () => {
    const before = await onHand(finishedGood.id);
    await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-26',
      customer: { name: 'Short Payer Two', phone: '9861000008' },
      lines: [{ productId: finishedGood.id, quantity: 1, ratePaise: 100000 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: 1 }] },
    });
    // The whole sale is one transaction: a rejected payment must not leave the
    // goods issued and an invoice posted behind it.
    expect(await onHand(finishedGood.id)).toBe(before);
  });

  it('allows a counter sale on credit, leaving the balance outstanding', async () => {
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-27',
      customer: { name: 'Credit Buyer', phone: '9861000009' },
      lines: [{ productId: finishedGood.id, quantity: 2, ratePaise: 100000 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.receipt).toBeNull();

    const list = await request(app)
      .get(`/api/v1/invoices?page=1&limit=50&customerPartyId=${res.body.data.customer.id}`)
      .set('Cookie', adminCookie);
    const row = list.body.data.rows.find((i) => i.id === res.body.data.invoice.id);
    expect(Number(row.outstandingPaise)).toBe(236000);
  });
});

describe('Delivery', () => {
  it('records the vehicle on the invoice when the goods are sent out', async () => {
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-28',
      customer: { name: 'Delivered Buyer', phone: '9861000010' },
      lines: [{ productId: finishedGood.id, quantity: 1, ratePaise: 100000 }],
      delivery: { vehicleNumber: 'OD-02-CT-9911', driverName: 'Bikash' },
      payment: { modes: [{ mode: 'UPI', amountPaise: 118000 }] },
    });
    expect(res.status).toBe(201);
    expect(res.body.data.invoice.vehicleNumber).toBe('OD-02-CT-9911');
    expect(res.body.data.invoice.driverName).toBe('Bikash');
  });

  it('requires a vehicle number when delivery is asked for', async () => {
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-28',
      customer: { name: 'No Vehicle', phone: '9861000011' },
      lines: [{ productId: finishedGood.id, quantity: 1, ratePaise: 100000 }],
      delivery: { driverName: 'Nobody' },
    });
    expect(res.status).toBe(400);
  });
});

describe('Inter-state', () => {
  it('charges IGST when the buyer declares another state', async () => {
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-29',
      customer: { name: 'Bengal Buyer', phone: '9861000012', state: 'West Bengal' },
      lines: [{ productId: finishedGood.id, quantity: 1, ratePaise: 100000 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: 118000 }] },
    });
    expect(res.status).toBe(201);
    expect(Number(res.body.data.invoice.igstPaise)).toBe(18000);
    expect(Number(res.body.data.invoice.cgstPaise)).toBe(0);
    expect(Number(res.body.data.invoice.sgstPaise)).toBe(0);
  });
});

describe('Cancellation', () => {
  it('puts the goods back when a counter sale is cancelled', async () => {
    const sold = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-30',
      customer: { name: 'Regretful Buyer', phone: '9861000013' },
      lines: [{ productId: finishedGood.id, quantity: 4, ratePaise: 100000 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: 472000 }] },
    });
    expect(sold.status).toBe(201);
    const afterSale = await onHand(finishedGood.id);

    // Money was taken, so the receipt has to be reversed first — the same rule
    // a B2B invoice follows, and the reason a credit note exists.
    const blocked = await request(app)
      .put(`/api/v1/invoices/${sold.body.data.invoice.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Customer changed their mind' });
    expect(blocked.status).toBe(400);

    await request(app)
      .put(`/api/v1/receipts/${sold.body.data.receipt.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Counter sale reversed' });

    const cancelled = await request(app)
      .put(`/api/v1/invoices/${sold.body.data.invoice.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Customer changed their mind' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    // The point of the whole exercise: the pallet is back on the shelf.
    expect(await onHand(finishedGood.id)).toBe(afterSale + 4);
  });
});

describe('Quoting before selling', () => {
  it('returns the exact total the sale will be raised for, and commits nothing', async () => {
    await produce(finishedGood.id, 30);
    const partiesBefore = await Party.count();

    const quote = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      customer: { name: 'Quote Only', phone: '9861009901' },
      lines: [{ productId: finishedGood.id, quantity: 3, ratePaise: 100000 }],
    });
    expect(quote.status).toBe(200);
    expect(Number(quote.body.data.subtotalPaise)).toBe(300000);
    expect(Number(quote.body.data.totalPaise)).toBe(354000);

    // A quote must not create the walk-in: they may still walk away.
    expect(await Party.count()).toBe(partiesBefore);

    // The whole point: paying exactly what was quoted is accepted. If the quote
    // and the sale computed tax or rounding differently, this would be rejected
    // as "payment does not match the invoice total".
    const sale = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-31',
      customer: { name: 'Quote Only', phone: '9861009901' },
      lines: [{ productId: finishedGood.id, quantity: 3, ratePaise: 100000 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: Number(quote.body.data.totalPaise) }] },
    });
    expect(sale.status).toBe(201);
    expect(Number(sale.body.data.invoice.totalPaise)).toBe(Number(quote.body.data.totalPaise));
  });

  it('agrees with the sale on a total that needs rupee rounding', async () => {
    // 2 x 310.00 = 620.00 + 18% = 731.60, which rounds to 732.00. This is the
    // arithmetic a browser-side total would have to reproduce exactly.
    await produce(pricedGood.id, 20);
    const quote = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      lines: [{ productId: pricedGood.id, quantity: 2 }],
    });
    expect(quote.status).toBe(200);
    expect(Number(quote.body.data.subtotalPaise)).toBe(62000);
    expect(Number(quote.body.data.totalPaise)).toBe(73200);
    expect(Number(quote.body.data.roundOffPaise)).toBe(40);
  });

  it('prices an unnamed basket, so lines can be quoted before the buyer is known', async () => {
    const res = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      lines: [{ productId: finishedGood.id, quantity: 1, ratePaise: 100000 }],
    });
    expect(res.status).toBe(200);
    // No state given and no party: the factory's own state stands in, so a
    // local sale quotes as CGST+SGST rather than IGST.
    expect(Number(res.body.data.cgstPaise)).toBe(9000);
    expect(Number(res.body.data.igstPaise)).toBe(0);
  });

  it('refuses to quote stock that is not free to sell', async () => {
    const res = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      lines: [{ productId: finishedGood.id, quantity: 99999, ratePaise: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/free stock/i);
  });
});

/**
 * BR-23: a product carrying a bundle rule takes its accessories with it. The
 * order flow has always done this; the counter did not, so the same pipe sold
 * across the counter went out without the gasket the rule calls mandatory.
 */
describe('Bundle accessories', () => {
  beforeAll(async () => {
    const { BundleRule, BundleComponent } = require('../src/models/index');

    bundled = await Product.create({
      tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Pipe Ctr', code: 'FG-PIPE-CTR',
      productType: 'FINISHED_GOOD', curingDays: 0, sellingPricePaise: 500000,
    });
    includedAccessory = await Product.create({
      tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Gasket Ctr', code: 'ACC-GSK-CTR',
      productType: 'FINISHED_GOOD', curingDays: 0, isAccessory: true, sellingPricePaise: 20000,
    });
    optionalAccessory = await Product.create({
      tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Lubricant Ctr', code: 'ACC-LUB-CTR',
      productType: 'FINISHED_GOOD', curingDays: 0, isAccessory: true, sellingPricePaise: 15000,
    });

    for (const p of [bundled, includedAccessory, optionalAccessory]) {
      const mix = await MixDesign.create({ tenantId, productId: p.id, name: 'Mix v1', version: 1, isActive: true });
      await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });
      await produce(p.id, 100);
    }

    const rule = await BundleRule.create({
      tenantId,
      parentProductId: bundled.id,
      code: 'BND-PIPE-CTR',
      name: 'Pipe with gasket',
      version: 1,
      status: 'ACTIVE',
      effectiveFrom: '2026-01-01',
    });

    // Components are rows, not a JSON column on the rule.
    // isMandatory: false + defaultSelected: true is how every rule in this
    // deployment is actually written — the accessory goes in, and may be taken
    // out again. Seeding it mandatory would have hidden the bug where the
    // counter filtered on the wrong flag and added nothing at all.
    await BundleComponent.create({
      tenantId, bundleRuleId: rule.id, componentProductId: includedAccessory.id,
      quantity: 1, uomId: uom.id, isMandatory: false, defaultSelected: true, sequence: 1,
    });
    // Genuinely optional: offered in the picker, never auto-created.
    await BundleComponent.create({
      tenantId, bundleRuleId: rule.id, componentProductId: optionalAccessory.id,
      quantity: 1, uomId: uom.id, isMandatory: false, defaultSelected: false, sequence: 2,
    });
  });

  it('quotes the accessory alongside the product it belongs to', async () => {
    const res = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      lines: [{ productId: bundled.id, quantity: 2, ratePaise: 500000 }],
    });
    expect(res.status).toBe(200);

    const gasket = res.body.data.lines.find((l) => l.productId === includedAccessory.id);
    expect(gasket).toBeTruthy();
    expect(Number(gasket.quantity)).toBe(2);
    // Marked so the counter screen can show it as something the rule added.
    expect(gasket.bundleParentProductId).toBe(bundled.id);

    // 2 pipes @ 5000 + 2 gaskets @ 200 = 10,400 taxable.
    expect(Number(res.body.data.subtotalPaise)).toBe(1040000);
  });

  it('leaves a not-default-selected accessory out of a walk-in basket', async () => {
    const res = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      lines: [{ productId: bundled.id, quantity: 1, ratePaise: 500000 }],
    });
    expect(res.body.data.lines.some((l) => l.productId === optionalAccessory.id)).toBe(false);
  });

  it('invoices and issues the accessory, not just the product', async () => {
    const gasketBefore = await onHand(includedAccessory.id);

    const quote = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      lines: [{ productId: bundled.id, quantity: 3, ratePaise: 500000 }],
    });

    const sale = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      customer: { name: 'Bundle Buyer', phone: '9861007001' },
      lines: [{ productId: bundled.id, quantity: 3, ratePaise: 500000 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: Number(quote.body.data.totalPaise) }] },
    });
    expect(sale.status).toBe(201);

    // Two invoice lines from one typed line.
    const productIds = sale.body.data.invoice.lines.map((l) => l.productId);
    expect(productIds).toContain(bundled.id);
    expect(productIds).toContain(includedAccessory.id);

    // And the gasket physically left the building.
    expect(await onHand(includedAccessory.id)).toBe(gasketBefore - 3);
  });
});

/**
 * Taking an accessory off a counter sale.
 *
 * The same discipline the sales-order flow applies: a reason from the
 * configured list, a note where the reason asks for one, and a mandatory
 * component only for someone holding the override grant. Every removal lands in
 * the audit log — that record is what makes the pattern of removals reportable,
 * which is the thing that actually changes behaviour.
 */
describe('Editing and removing accessories', () => {
  const { OverrideReasonCode } = require('../src/models/index');
  const { AuditLog } = require('../src/api/audit/auditLog.model');

  beforeAll(async () => {
    await OverrideReasonCode.create({ tenantId, code: 'NOT_NEEDED', label: 'Customer does not want it', requiresNote: false, isActive: true });
    await OverrideReasonCode.create({ tenantId, code: 'OTHER', label: 'Other', requiresNote: true, isActive: true });
    await OverrideReasonCode.create({ tenantId, code: 'RETIRED', label: 'Retired reason', requiresNote: false, isActive: false });
  });

  const quoteWithOverride = (override, quantity = 2) =>
    request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      lines: [{ productId: bundled.id, quantity, ratePaise: 500000, accessoryOverrides: [override] }],
    });

  it('changes the accessory quantity without touching the parent', async () => {
    const res = await quoteWithOverride({ componentProductId: includedAccessory.id, qty: 5 });
    expect(res.status).toBe(200);
    const gasket = res.body.data.lines.find((l) => l.productId === includedAccessory.id);
    expect(Number(gasket.quantity)).toBe(5);
    // 2 pipes @ 5000 + 5 gaskets @ 200 = 11,000.
    expect(Number(res.body.data.subtotalPaise)).toBe(1100000);
  });

  it('changes the accessory rate', async () => {
    const res = await quoteWithOverride({ componentProductId: includedAccessory.id, ratePaise: 30000 });
    expect(res.status).toBe(200);
    const gasket = res.body.data.lines.find((l) => l.productId === includedAccessory.id);
    expect(Number(gasket.ratePaise)).toBe(30000);
    // 2 pipes @ 5000 + 2 gaskets @ 300 = 10,600.
    expect(Number(res.body.data.subtotalPaise)).toBe(1060000);
  });

  it('removes the accessory when a reason is given', async () => {
    const res = await quoteWithOverride({
      componentProductId: includedAccessory.id, removed: true, reasonCode: 'NOT_NEEDED',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.lines.some((l) => l.productId === includedAccessory.id)).toBe(false);
    expect(Number(res.body.data.subtotalPaise)).toBe(1000000);
  });

  it('refuses a removal with no reason', async () => {
    const res = await quoteWithOverride({ componentProductId: includedAccessory.id, removed: true });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/choose a reason/i);
  });

  it('refuses a reason that is not on the active list', async () => {
    const res = await quoteWithOverride({
      componentProductId: includedAccessory.id, removed: true, reasonCode: 'RETIRED',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/choose a reason/i);
  });

  it('demands a note for a reason that asks for one', async () => {
    const withoutNote = await quoteWithOverride({
      componentProductId: includedAccessory.id, removed: true, reasonCode: 'OTHER',
    });
    expect(withoutNote.status).toBe(400);
    expect(withoutNote.body.message).toMatch(/needs a note/i);

    const withNote = await quoteWithOverride({
      componentProductId: includedAccessory.id, removed: true, reasonCode: 'OTHER', reasonNote: 'Damaged in the yard',
    });
    expect(withNote.status).toBe(200);
  });

  it('records who removed what, and why, against the invoice', async () => {
    const quote = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      lines: [{
        productId: bundled.id, quantity: 1, ratePaise: 500000,
        accessoryOverrides: [{ componentProductId: includedAccessory.id, removed: true, reasonCode: 'NOT_NEEDED' }],
      }],
    });

    const sale = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      customer: { name: 'Declined Gasket', phone: '9861008001' },
      lines: [{
        productId: bundled.id, quantity: 1, ratePaise: 500000,
        accessoryOverrides: [{ componentProductId: includedAccessory.id, removed: true, reasonCode: 'NOT_NEEDED' }],
      }],
      payment: { modes: [{ mode: 'CASH', amountPaise: Number(quote.body.data.totalPaise) }] },
    });
    expect(sale.status).toBe(201);

    // The gasket is not on the invoice...
    expect(sale.body.data.invoice.lines.map((l) => l.productId)).not.toContain(includedAccessory.id);

    // ...and the decision is on the record, with the reason and the person.
    const entry = await AuditLog.findOne({
      where: { entityType: 'CounterSaleAccessory', entityId: sale.body.data.invoice.id, action: 'REMOVE' },
    });
    expect(entry).toBeTruthy();
    expect(entry.beforeSnapshot.productId).toBe(includedAccessory.id);
    expect(entry.afterSnapshot.reasonCode).toBe('NOT_NEEDED');
    expect(entry.userId).toBeTruthy();
  });

  it('writes nothing to the audit log for a quote that is never completed', async () => {
    const before = await AuditLog.count({ where: { entityType: 'CounterSaleAccessory' } });
    await quoteWithOverride({ componentProductId: includedAccessory.id, removed: true, reasonCode: 'NOT_NEEDED' });
    expect(await AuditLog.count({ where: { entityType: 'CounterSaleAccessory' } })).toBe(before);
  });
});

/**
 * Per-line discount.
 *
 * A discount given at the time of supply and shown on the invoice reduces the
 * taxable value (s.15(3)(a) CGST Act), so the tax must fall with it. Charging
 * GST on the undiscounted price would overcharge the customer and overstate
 * output tax in GSTR-1.
 */
describe('Discount', () => {
  it('takes the discount off the taxable value, and the tax with it', async () => {
    const res = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      lines: [{ productId: finishedGood.id, quantity: 10, ratePaise: 100000, discountPercent: 10 }],
    });
    expect(res.status).toBe(200);

    // Gross 10,000; 10% off = 1,000; taxable 9,000; GST 18% of 9,000 = 1,620.
    expect(Number(res.body.data.discountPaise)).toBe(100000);
    expect(Number(res.body.data.subtotalPaise)).toBe(900000);
    expect(Number(res.body.data.cgstPaise)).toBe(81000);
    expect(Number(res.body.data.sgstPaise)).toBe(81000);
    expect(Number(res.body.data.totalPaise)).toBe(1062000);
  });

  it('matches the undiscounted figures when no discount is given', async () => {
    const res = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      lines: [{ productId: finishedGood.id, quantity: 10, ratePaise: 100000 }],
    });
    expect(Number(res.body.data.discountPaise)).toBe(0);
    expect(Number(res.body.data.subtotalPaise)).toBe(1000000);
    expect(Number(res.body.data.totalPaise)).toBe(1180000);
  });

  it('stores what was entered and what it came to, on the invoice line', async () => {
    const quote = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      lines: [{ productId: finishedGood.id, quantity: 4, ratePaise: 100000, discountPercent: 25 }],
    });

    const sale = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      customer: { name: 'Discount Buyer', phone: '9861009001' },
      lines: [{ productId: finishedGood.id, quantity: 4, ratePaise: 100000, discountPercent: 25 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: Number(quote.body.data.totalPaise) }] },
    });
    expect(sale.status).toBe(201);

    const line = sale.body.data.invoice.lines.find((l) => l.productId === finishedGood.id);
    // Both are kept: the percentage someone chose, and the money it removed.
    expect(Number(line.discountPercent)).toBe(25);
    expect(Number(line.discountPaise)).toBe(100000);
    // 4 x 1000 = 4,000 gross, 25% off = 3,000 taxable.
    expect(Number(line.taxableAmountPaise)).toBe(300000);
  });

  it('refuses a discount outside 0–100 percent', async () => {
    for (const discountPercent of [-5, 150]) {
      const res = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
        factoryId: factory.id,
        invoiceDate: '2026-09-01',
        lines: [{ productId: finishedGood.id, quantity: 1, ratePaise: 100000, discountPercent }],
      });
      expect(res.status).toBe(400);
    }
  });

  it('discounts an accessory independently of the product that brought it', async () => {
    const res = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      lines: [{
        productId: bundled.id, quantity: 2, ratePaise: 500000,
        accessoryOverrides: [{ componentProductId: includedAccessory.id, discountPercent: 50 }],
      }],
    });
    expect(res.status).toBe(200);

    const gasket = res.body.data.lines.find((l) => l.productId === includedAccessory.id);
    // Gasket: 2 x 200 = 400 gross, half off = 200 taxable. Pipe untouched.
    expect(Number(gasket.discountPaise)).toBe(20000);
    expect(Number(gasket.taxableAmountPaise)).toBe(20000);
    const pipe = res.body.data.lines.find((l) => l.productId === bundled.id);
    expect(Number(pipe.discountPaise)).toBe(0);
  });

  it('lets a full discount give something away without breaking the invoice', async () => {
    const res = await request(app).post('/api/v1/retail/counter-sales/quote').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      invoiceDate: '2026-09-01',
      lines: [{ productId: finishedGood.id, quantity: 1, ratePaise: 100000, discountPercent: 100 }],
    });
    expect(res.status).toBe(200);
    expect(Number(res.body.data.subtotalPaise)).toBe(0);
    // No taxable value means no tax — not tax on the list price.
    expect(Number(res.body.data.cgstPaise)).toBe(0);
    expect(Number(res.body.data.totalPaise)).toBe(0);
  });
});
