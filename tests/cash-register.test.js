const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, MixDesign, MixDesignLine, Party,
} = require('../src/models/index');

/**
 * Cash register sessions at the counter.
 *
 * The till opens empty, takes a ₹590 cash sale, pays ₹100 out for diesel, and
 * is counted at close. The session never moves money itself — it compares the
 * drawer with the cash account and, only when asked, writes the difference to
 * Cash Short / Excess.
 */

const PASSWORD = 'password123';
let cookie;
let factory;
let paver;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const api = {
  get: (url, query) => request(app).get(url).set('Cookie', cookie).query(query || {}),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookie).send(body),
};

const cashBalance = async () => {
  const tb = await api.get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`);
  const row = tb.body.data.find((r) => r.code === '1000');
  return row ? row.balancePaise : 0;
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Till Precast', slug: 'till-precast', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Till Precast Pvt Ltd', code: 'TPL' });
  await User.create(
    { tenantId, email: 'admin@till.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Till Plant', code: 'TIL', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-TIL' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast concrete', gstRatePercent: 18 });
  const cement = await Product.create({ tenantId, uomId: uom.id, name: 'Cement Til', code: 'RM-CEM-TIL', productType: 'RAW_MATERIAL', curingDays: 0 });
  paver = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Paver Til', code: 'FG-PAV-TIL', productType: 'FINISHED_GOOD', curingDays: 0 });
  const mix = await MixDesign.create({ tenantId, productId: paver.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: cement.id, quantityPerUnit: 1, uomId: uom.id });

  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Til Cement Co' });

  cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@till.co', password: PASSWORD }), 'accessToken');
  expect((await api.post('/api/v1/purchasing/receipts', {
    factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-06-01',
    lines: [{ productId: cement.id, receivedQty: 200, ratePaise: 500 }],
  })).status).toBe(201);
  expect((await api.post('/api/v1/production/entries', {
    factoryId: factory.id, productId: paver.id, productionDate: '2026-06-01', goodQty: 100,
  })).status).toBe(201);
});

afterAll(async () => {
  await sequelize.close();
});

describe('A shift at the till', () => {
  let session;

  it('opens on a count of an empty drawer', async () => {
    const res = await api.post('/api/v1/cash-register/sessions', { factoryId: factory.id, denominations: {}, note: 'Morning shift' });
    expect(res.status).toBe(201);
    session = res.body.data;
    expect(session.sessionNumber).toMatch(/^CS\//);
    expect(session.status).toBe('OPEN');
    expect(session.openingCountedPaise).toBe(0);
    expect(session.openingExpectedPaise).toBe(0);
    expect(session.openingVariancePaise).toBe(0);
  });

  it('will not open a second till while one is open', async () => {
    const res = await api.post('/api/v1/cash-register/sessions', { factoryId: factory.id, denominations: {} });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/still open/);
  });

  it('is the session the counter screen finds', async () => {
    const res = await api.get('/api/v1/cash-register/sessions/current', { factoryId: factory.id });
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(session.id);
  });

  it('shows the cash sale and the payout that happened during the shift', async () => {
    const sale = await api.post('/api/v1/retail/counter-sales', {
      factoryId: factory.id, invoiceDate: '2026-06-02',
      customer: { name: 'Till Buyer', phone: '9862000001' },
      lines: [{ productId: paver.id, quantity: 10, ratePaise: 5000 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: 59000 }] },
    });
    expect(sale.status).toBe(201);
    const payout = await api.post('/api/v1/expenses', {
      factoryId: factory.id, expenseDate: '2026-06-02', category: 'Diesel', mode: 'CASH', amountPaise: 10000,
    });
    expect(payout.status).toBe(201);

    const res = await api.get(`/api/v1/cash-register/sessions/${session.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.totalInPaise).toBe(59000);
    expect(res.body.data.totalOutPaise).toBe(10000);
    expect(res.body.data.expectedNowPaise).toBe(49000);
    expect(res.body.data.movements.map((m) => m.referenceType)).toEqual(['Receipt', 'Expense']);
  });

  it('counts the drawer at close and reports the shortfall without touching the books', async () => {
    // ₹480 counted against ₹490 expected — a ₹10 note is missing.
    const res = await api.put(`/api/v1/cash-register/sessions/${session.id}/close`, {
      denominations: { 200: 2, 50: 1, 20: 1, 10: 1 },
      note: 'Short by a ten',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CLOSED');
    expect(res.body.data.closingCountedPaise).toBe(48000);
    expect(res.body.data.closingExpectedPaise).toBe(49000);
    expect(res.body.data.closingVariancePaise).toBe(-1000);
    expect(res.body.data.varianceAdjusted).toBe(false);
    // Nothing was written off, so the books still say ₹490.
    expect(await cashBalance()).toBe(49000);
  });

  it('will not close twice', async () => {
    const res = await api.put(`/api/v1/cash-register/sessions/${session.id}/close`, { denominations: {} });
    expect(res.status).toBe(400);
  });
});

describe('Accepting the difference', () => {
  it('writes a shortfall off to Cash Short / Excess so the books match the drawer', async () => {
    const opened = await api.post('/api/v1/cash-register/sessions', { factoryId: factory.id, denominations: { 200: 2, 50: 1, 20: 1, 10: 1 } });
    expect(opened.status).toBe(201);
    // Opening count is the ₹480 actually there against ₹490 in the books.
    expect(opened.body.data.openingVariancePaise).toBe(-1000);

    const res = await api.put(`/api/v1/cash-register/sessions/${opened.body.data.id}/close`, {
      denominations: { 200: 2, 50: 1, 20: 1, 10: 1 }, postAdjustment: true, note: 'Accepted the shortfall',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.closingVariancePaise).toBe(-1000);
    expect(res.body.data.varianceAdjusted).toBe(true);
    expect(await cashBalance()).toBe(48000);

    const tb = await api.get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`);
    expect(tb.body.data.find((r) => r.code === '5960').balancePaise).toBe(1000);
  });

  it('credits Cash Short / Excess when the drawer holds more than the books say', async () => {
    const opened = await api.post('/api/v1/cash-register/sessions', { factoryId: factory.id, denominations: { 200: 2, 50: 1, 20: 1, 10: 1 } });
    const res = await api.put(`/api/v1/cash-register/sessions/${opened.body.data.id}/close`, {
      denominations: { 500: 1 }, postAdjustment: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.closingVariancePaise).toBe(2000);
    expect(await cashBalance()).toBe(50000);
    const tb = await api.get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`);
    expect(tb.body.data.find((r) => r.code === '5960').balancePaise).toBe(-1000);
  });

  it('refuses a count that is not whole notes', async () => {
    const opened = await api.post('/api/v1/cash-register/sessions', { factoryId: factory.id, denominations: {} });
    const res = await api.put(`/api/v1/cash-register/sessions/${opened.body.data.id}/close`, { denominations: { 500: 1.5 } });
    expect(res.status).toBe(400);
  });
});
