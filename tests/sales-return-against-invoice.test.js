const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, MixDesign, MixDesignLine, Party,
} = require('../src/models/index');
const { isoDateInZone } = require('../src/utils/dateDisplay');
const { env } = require('../src/config/env');

/**
 * Returning goods against the invoice they went out on.
 *
 * Typing a product, a quantity and a rate by hand allows three mistakes at
 * once: goods that were never sold, more than was sold, and a rate the customer
 * never paid. The screen now picks from the customer's invoices, and the server
 * holds the quantity rule that makes that trustworthy.
 */

const PASSWORD = 'password123';
const day = (offset) => isoDateInZone(new Date(Date.now() + offset * 86400000), env.APP_TIMEZONE);

let api;
let tenantId;
let strayProduct;
let factory;
let customer;
let other;
let pipe;
let gasket;
let invoiceId;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const ok = (res, expected = 201) => {
  if (res.status !== expected) throw new Error(`${expected} expected, got ${res.status}: ${res.body.message || ''}`);
  return res.body.data;
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Return Precast', slug: 'return-precast', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Return Precast Pvt Ltd', code: 'RPL' });
  await User.create(
    { tenantId, email: 'admin@returns.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Asha', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Return Plant', code: 'RTN', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-RTN' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast', gstRatePercent: 18 });
  const cement = await Product.create({ tenantId, uomId: uom.id, name: 'Cement Rtn', code: 'RM-CEM-RTN', productType: 'RAW_MATERIAL', curingDays: 0 });
  pipe = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'RCC Pipe 600mm Rtn', code: 'FG-PIPE-RTN', productType: 'FINISHED_GOOD', curingDays: 0 });
  gasket = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'EPDM Gasket Rtn', code: 'FG-GSK-RTN', productType: 'FINISHED_GOOD', curingDays: 0 });
  for (const product of [pipe, gasket]) {
    const mix = await MixDesign.create({ tenantId, productId: product.id, name: 'Mix v1', version: 1, isActive: true });
    await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: cement.id, quantityPerUnit: 1, uomId: uom.id });
  }
  // Something this customer never bought, for the "not on the invoice" case.
  strayProduct = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Never Sold Rtn', code: 'FG-NEVER-RTN', productType: 'FINISHED_GOOD', curingDays: 0 });
  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Rtn Cement Co' });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Rtn Buyer', state: 'Odisha' });
  other = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Someone Else', state: 'Odisha' });

  const cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@returns.co', password: PASSWORD }), 'accessToken');
  api = {
    get: (url, query) => request(app).get(url).set('Cookie', cookie).query(query || {}),
    post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  };

  ok(await api.post('/api/v1/purchasing/receipts', {
    factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: day(-20),
    lines: [{ productId: cement.id, receivedQty: 500, ratePaise: 500 }],
  }));
  ok(await api.post('/api/v1/production/entries', { factoryId: factory.id, productId: pipe.id, productionDate: day(-15), goodQty: 100 }));
  ok(await api.post('/api/v1/production/entries', { factoryId: factory.id, productId: gasket.id, productionDate: day(-15), goodQty: 100 }));

  // One counter sale: 10 pipes at ₹1,000 and 20 gaskets at ₹50.
  const sale = ok(await api.post('/api/v1/retail/counter-sales', {
    factoryId: factory.id, invoiceDate: day(-5),
    customer: { partyId: customer.id },
    lines: [
      { productId: pipe.id, quantity: 10, ratePaise: 100000 },
      { productId: gasket.id, quantity: 20, ratePaise: 5000 },
    ],
    payment: { modes: [{ mode: 'CASH', amountPaise: 1298000 }] },
  }));
  invoiceId = sale.invoice.id;
});

afterAll(async () => {
  await sequelize.close();
});

describe('What the customer can send back', () => {
  it('lists their invoices with the quantity and the rate they were sold at', async () => {
    const res = await api.get('/api/v1/returns/returnable', { factoryId: factory.id, customerPartyId: customer.id });
    expect(res.status).toBe(200);
    const invoice = res.body.data.invoices.find((i) => i.invoiceId === invoiceId);
    expect(invoice.fullyReturned).toBe(false);

    const pipeLine = invoice.lines.find((l) => l.productId === pipe.id);
    expect(pipeLine).toMatchObject({ productName: 'RCC Pipe 600mm Rtn', soldQty: 10, ratePaise: 100000, returnedQty: 0, returnableQty: 10 });
  });

  it('shows nothing for a customer who has bought nothing here', async () => {
    const res = await api.get('/api/v1/returns/returnable', { factoryId: factory.id, customerPartyId: other.id });
    expect(res.body.data.invoices).toHaveLength(0);
    expect(res.body.data.unlinkedReturns).toHaveLength(0);
  });
});

describe('Returning against that invoice', () => {
  it('accepts a part of a line and reduces what is left', async () => {
    const res = await api.post('/api/v1/returns/sales-returns', {
      factoryId: factory.id, customerPartyId: customer.id, salesInvoiceId: invoiceId,
      returnDate: day(-1), reason: 'Two cracked in transit',
      lines: [{ productId: pipe.id, quantity: 2, ratePaise: 100000 }],
    });
    expect(res.status).toBe(201);

    const after = await api.get('/api/v1/returns/returnable', { factoryId: factory.id, customerPartyId: customer.id });
    const line = after.body.data.invoices.find((i) => i.invoiceId === invoiceId).lines.find((l) => l.productId === pipe.id);
    expect(line.returnedQty).toBe(2);
    expect(line.returnableQty).toBe(8);
  });

  it('refuses more than the invoice has left, naming the numbers', async () => {
    const res = await api.post('/api/v1/returns/sales-returns', {
      factoryId: factory.id, customerPartyId: customer.id, salesInvoiceId: invoiceId,
      returnDate: day(-1), reason: 'Trying it on',
      lines: [{ productId: pipe.id, quantity: 9, ratePaise: 100000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only 8 .* can still be returned/);
    expect(res.body.message).toMatch(/10 sold, 2 already returned/);
  });

  it('refuses an item that is not on the invoice at all', async () => {
    const res = await api.post('/api/v1/returns/sales-returns', {
      factoryId: factory.id, customerPartyId: customer.id, salesInvoiceId: invoiceId,
      returnDate: day(-1), reason: 'Wrong item',
      lines: [{ productId: strayProduct.id, quantity: 1, ratePaise: 1000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/is not on invoice/);
  });

  it('refuses another customer’s invoice', async () => {
    const res = await api.post('/api/v1/returns/sales-returns', {
      factoryId: factory.id, customerPartyId: other.id, salesInvoiceId: invoiceId,
      returnDate: day(-1), reason: 'Not theirs',
      lines: [{ productId: pipe.id, quantity: 1, ratePaise: 100000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/different customer/);
  });

  it('marks an invoice fully returned once everything is back', async () => {
    expect((await api.post('/api/v1/returns/sales-returns', {
      factoryId: factory.id, customerPartyId: customer.id, salesInvoiceId: invoiceId,
      returnDate: day(-1), reason: 'Contract cancelled',
      lines: [
        { productId: pipe.id, quantity: 8, ratePaise: 100000 },
        { productId: gasket.id, quantity: 20, ratePaise: 5000 },
      ],
    })).status).toBe(201);

    const after = await api.get('/api/v1/returns/returnable', { factoryId: factory.id, customerPartyId: customer.id });
    const invoice = after.body.data.invoices.find((i) => i.invoiceId === invoiceId);
    expect(invoice.fullyReturned).toBe(true);
    expect(invoice.lines.every((l) => l.returnableQty === 0)).toBe(true);
  });

  it('still allows a return with no invoice named, and reports it separately', async () => {
    const res = await api.post('/api/v1/returns/sales-returns', {
      factoryId: factory.id, customerPartyId: customer.id,
      returnDate: day(-1), reason: 'Sold before go-live',
      lines: [{ productId: pipe.id, quantity: 3, ratePaise: 90000 }],
    });
    expect(res.status).toBe(201);

    const after = await api.get('/api/v1/returns/returnable', { factoryId: factory.id, customerPartyId: customer.id });
    expect(after.body.data.unlinkedReturns).toEqual([
      expect.objectContaining({ productName: 'RCC Pipe 600mm Rtn', quantity: 3 }),
    ]);
    // It is not deducted from the invoice, which was already fully returned.
    const invoice = after.body.data.invoices.find((i) => i.invoiceId === invoiceId);
    expect(invoice.lines.find((l) => l.productId === pipe.id).returnedQty).toBe(10);
  });
});

describe('The tax comes back with the goods', () => {
  let secondInvoiceId;
  let secondCustomer;

  const balance = async (code) => {
    const tb = await api.get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`);
    const row = tb.body.data.find((r) => r.code === code);
    return row ? row.balancePaise : 0;
  };

  beforeAll(async () => {
    secondCustomer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Tax Buyer', state: 'Odisha' });
    ok(await api.post('/api/v1/production/entries', { factoryId: factory.id, productId: pipe.id, productionDate: day(-3), goodQty: 50 }));
    // 10 pipes at ₹1,000 → taxable ₹10,000, GST 18% = ₹1,800, invoice ₹11,800.
    const sale = ok(await api.post('/api/v1/retail/counter-sales', {
      factoryId: factory.id, invoiceDate: day(-2),
      customer: { partyId: secondCustomer.id },
      lines: [{ productId: pipe.id, quantity: 10, ratePaise: 100000 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: 1180000 }] },
    }));
    secondInvoiceId = sale.invoice.id;
  });

  it('credits the customer the tax-inclusive amount, not the net', async () => {
    const outputBefore = await balance('2100');   // GST Output — CGST
    const receivableBefore = await balance('1100');

    // Four of ten come back: taxable ₹4,000, GST ₹720, credit ₹4,720.
    const salesReturn = ok(await api.post('/api/v1/returns/sales-returns', {
      factoryId: factory.id, customerPartyId: secondCustomer.id, salesInvoiceId: secondInvoiceId,
      returnDate: day(-1), reason: 'Four cracked',
      lines: [{ productId: pipe.id, quantity: 4, ratePaise: 100000 }],
    }));

    expect(salesReturn.subtotalPaise).toBe(400000);
    expect(salesReturn.cgstPaise).toBe(36000);
    expect(salesReturn.sgstPaise).toBe(36000);
    expect(salesReturn.igstPaise).toBe(0);
    expect(salesReturn.totalAmountPaise).toBe(472000);

    // The customer's dues fall by the whole credit, tax included.
    expect(await balance('1100')).toBe(receivableBefore - 472000);
    // And the output tax the business no longer owes is reversed: a debit to a
    // liability account moves its balance up towards zero.
    expect(await balance('2100')).toBe(outputBefore + 36000);
  });

  it('keeps the books balanced, with the return sitting in the P&L at its net value', async () => {
    const tb = await api.get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`);
    expect(tb.body.data.reduce((sum, r) => sum + r.balancePaise, 0)).toBe(0);

    const bs = await api.get('/api/v1/ledger/balance-sheet', { asOf: day(0), factoryId: factory.id });
    expect(bs.body.data.differencePaise).toBe(0);

    // Sales Return is a contra-income account: it carries the net, never the tax.
    const salesReturnAccount = tb.body.data.find((r) => r.code === '4900');
    expect(salesReturnAccount.balancePaise).toBeGreaterThan(0);
  });

  it('reports the note to GSTR-1 at its tax-inclusive value', async () => {
    const res = await api.get('/api/v1/gstr/gstr1', { factoryId: factory.id, fromDate: '2026-04-01', toDate: day(0) });
    const note = res.body.data.creditDebitNotes.find((n) => n.noteType === 'SALES_RETURN' && n.valuePaise === 472000);
    expect(note).toBeTruthy();
  });
});
