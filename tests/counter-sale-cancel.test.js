const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, MixDesign, MixDesignLine, Party,
} = require('../src/models/index');
const { SalesInvoice } = require('../src/api/invoicing/salesInvoice.model');
const { Receipt } = require('../src/api/payments/receipt.model');
const { isoDateInZone } = require('../src/utils/dateDisplay');
const { env } = require('../src/config/env');

/**
 * Cancelling a counter sale.
 *
 * A counter sale is goods out and money in together, in one motion, by one
 * person standing at a counter. Undoing it has to be the same shape — and
 * before this it was not: the invoice refused to cancel while a receipt was
 * allocated to it, and cancelling the receipt first left the sale posted and
 * reading as unpaid, repairable only by keying a manual receipt in the finance
 * module. A real sale sat in exactly that half-state for a week.
 */

const PASSWORD = 'password123';
const day = (offset) => isoDateInZone(new Date(Date.now() + offset * 86400000), env.APP_TIMEZONE);

let api;
let tenantId;
let factory;
let customer;
let pipe;

const ok = (res, expected = 201) => {
  if (res.status !== expected) throw new Error(`${expected} expected, got ${res.status}: ${res.body.message || ''}`);
  return res.body.data;
};

const stockOf = async (productId) => {
  const [row] = await sequelize.query(
    `SELECT COALESCE(SUM(CASE WHEN direction = 'IN' THEN quantity ELSE -quantity END), 0)::float AS qty
       FROM stock_ledger_entries WHERE "productId" = $1`,
    { bind: [productId], type: sequelize.QueryTypes.SELECT }
  );
  return Number(row.qty);
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Counter Co', slug: 'counter-co', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Counter Co Pvt Ltd', code: 'CCL' });
  await User.create(
    { tenantId, email: 'admin@counter.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Asha', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Counter Plant', code: 'CTR', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-CTR' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast', gstRatePercent: 18 });
  const cement = await Product.create({ tenantId, uomId: uom.id, name: 'Cement Ctr', code: 'RM-CEM-CTR', productType: 'RAW_MATERIAL', curingDays: 0 });
  pipe = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'RCC Pipe Ctr', code: 'FG-PIPE-CTR', productType: 'FINISHED_GOOD', curingDays: 0 });
  const mix = await MixDesign.create({ tenantId, productId: pipe.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: cement.id, quantityPerUnit: 1, uomId: uom.id });

  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Ctr Cement Co' });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Ctr Buyer', state: 'Odisha' });

  const cookie = (await request(app).post('/api/v1/auth/login').send({ email: 'admin@counter.co', password: PASSWORD }))
    .headers['set-cookie'].find((c) => c.startsWith('accessToken=')).split(';')[0];
  api = {
    get: (url, query) => request(app).get(url).set('Cookie', cookie).query(query || {}),
    post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
    put: (url, body) => request(app).put(url).set('Cookie', cookie).send(body),
  };

  ok(await api.post('/api/v1/purchasing/receipts', {
    factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: day(-20),
    lines: [{ productId: cement.id, receivedQty: 500, ratePaise: 500 }],
  }));
  ok(await api.post('/api/v1/production/entries', { factoryId: factory.id, productId: pipe.id, productionDate: day(-10), goodQty: 100 }));
});

afterAll(async () => {
  await sequelize.close();
});

/** A paid counter sale: 10 pipes at 1,000 plus 18% GST. */
const sell = async () => ok(await api.post('/api/v1/retail/counter-sales', {
  factoryId: factory.id, invoiceDate: day(0),
  customer: { partyId: customer.id },
  lines: [{ productId: pipe.id, quantity: 10, ratePaise: 100000 }],
  payment: { modes: [{ mode: 'CASH', amountPaise: 1180000 }] },
}));

describe('A counter sale settles itself', () => {
  it('leaves nothing outstanding — that is the whole point of the counter', async () => {
    const sale = await sell();
    expect(sale.receipt).toBeTruthy();
    expect(Number(sale.receipt.totalAmountPaise)).toBe(1180000);

    const res = await api.get('/api/v1/invoices', { search: sale.invoice.invoiceNumber });
    const listed = res.body.data.rows.find((row) => row.invoiceNumber === sale.invoice.invoiceNumber);
    expect(Number(listed.outstandingPaise ?? 0)).toBe(0);
  });
});

describe('Cancelling one', () => {
  it('refuses to cancel the payment on its own, which would strand the sale', async () => {
    const sale = await sell();
    const res = await api.put(`/api/v1/receipts/${sale.receipt.id}/cancel`, { reason: 'Changed their mind' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/payment for counter sale/);
    expect(res.body.message).toMatch(/Cancel the counter sale instead/);

    // Still whole: neither half moved.
    expect((await Receipt.findByPk(sale.receipt.id)).status).toBe('POSTED');
    expect((await SalesInvoice.findByPk(sale.invoice.id)).status).toBe('POSTED');
  });

  it('reverses the sale and its money together, and puts the stock back', async () => {
    const before = await stockOf(pipe.id);
    const sale = await sell();
    expect(await stockOf(pipe.id)).toBe(before - 10);

    const res = await api.post(`/api/v1/retail/counter-sales/${sale.invoice.id}/cancel`, { reason: 'Customer returned at the counter' });
    expect(res.status).toBe(200);
    expect(res.body.data.cancelledReceipts).toContain(sale.receipt.receiptNumber);

    expect((await SalesInvoice.findByPk(sale.invoice.id)).status).toBe('CANCELLED');
    expect((await Receipt.findByPk(sale.receipt.id)).status).toBe('CANCELLED');
    expect(await stockOf(pipe.id)).toBe(before);
  });

  it('leaves the books balanced afterwards', async () => {
    const sale = await sell();
    await api.post(`/api/v1/retail/counter-sales/${sale.invoice.id}/cancel`, { reason: 'Rung up in error' });

    const [{ net }] = await sequelize.query(
      'SELECT (SUM("debitPaise") - SUM("creditPaise"))::bigint AS net FROM journal_lines WHERE "tenantId" = $1',
      { bind: [tenantId], type: sequelize.QueryTypes.SELECT }
    );
    expect(Number(net)).toBe(0);
  });

  it('insists on a reason, like every other cancellation', async () => {
    const sale = await sell();
    const res = await api.post(`/api/v1/retail/counter-sales/${sale.invoice.id}/cancel`, {});
    expect(res.status).toBe(400);
  });

  it('will not cancel the same sale twice', async () => {
    const sale = await sell();
    await api.post(`/api/v1/retail/counter-sales/${sale.invoice.id}/cancel`, { reason: 'First time' });
    const again = await api.post(`/api/v1/retail/counter-sales/${sale.invoice.id}/cancel`, { reason: 'Second time' });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/Only a POSTED counter sale/);
  });

  it('refuses an invoice that was not sold over the counter', async () => {
    const sale = await sell();
    await SalesInvoice.update({ saleChannel: 'B2B' }, { where: { id: sale.invoice.id } });
    const res = await api.post(`/api/v1/retail/counter-sales/${sale.invoice.id}/cancel`, { reason: 'Wrong screen' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a counter sale/);
  });

  it('still lets an ordinary receipt be cancelled on its own', async () => {
    // Nothing above should have made the normal finance flow stricter.
    const receipt = ok(await api.post('/api/v1/receipts', {
      factoryId: factory.id, customerPartyId: customer.id, receiptDate: day(0),
      modes: [{ mode: 'CASH', amountPaise: 50000 }],
    }));
    const res = await api.put(`/api/v1/receipts/${receipt.id}/cancel`, { reason: 'Keyed twice' });
    expect(res.status).toBe(200);
    expect((await Receipt.findByPk(receipt.id)).status).toBe('CANCELLED');
  });
});
