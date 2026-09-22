const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, Factory, FinancialYear } = require('../src/models/index');

/**
 * Fixed assets: register, depreciate, dispose.
 *
 *   Mould   bought 1 Apr for ₹12,000 from HDFC, straight line over 12 months
 *   Truck   owned before go-live: cost ₹10,000, ₹4,000 already written off,
 *           written-down value at 15% a year
 *
 * April run (30 days):
 *   mould  12,00,000 paise × 30/365          =  98,630 paise
 *   truck  (10,00,000 − 4,00,000) × 15% × 30/365 = 7,397 paise
 */

const PASSWORD = 'password123';
let cookie;
let factory;
let hdfc;
let mould;
let truck;

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

const balanceByCode = async (code) => {
  const tb = await api.get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`);
  const row = tb.body.data.find((r) => r.code === code);
  return row ? row.balancePaise : 0;
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Asset Precast', slug: 'asset-precast', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Asset Precast Pvt Ltd', code: 'APL' });
  await User.create(
    { tenantId, email: 'admin@assets.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Asset Plant', code: 'AST', state: 'Odisha' });
  cookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@assets.co', password: PASSWORD }),
    'accessToken'
  );
  hdfc = (await api.post('/api/v1/ledger/accounts', {
    code: '1011', name: 'HDFC', accountGroup: 'CURRENT_ASSET', subType: 'BANK',
    openingBalance: { factoryId: factory.id, asOfDate: '2026-03-31', amountPaise: 5000000 },
  })).body.data;
});

afterAll(async () => {
  await sequelize.close();
});

describe('Registering assets', () => {
  it('posts a purchased asset against the bank it was paid from', async () => {
    const res = await api.post('/api/v1/fixed-assets', {
      factoryId: factory.id, name: 'RCC Pipe Mould 600mm', category: 'Moulds', acquisitionType: 'PURCHASED',
      acquisitionDate: '2026-04-01', costPaise: 1200000, method: 'SLM', usefulLifeMonths: 12,
      payment: { mode: 'BANK', accountId: hdfc.id },
    });
    expect(res.status).toBe(201);
    mould = res.body.data;
    expect(mould.assetNumber).toMatch(/^FA\//);
    expect(mould.bookValuePaise).toBe(1200000);
    expect(await balanceByCode('1500')).toBe(1200000);
    expect(await balanceByCode('1011')).toBe(5000000 - 1200000);
  });

  it('brings in an asset already owned, with its depreciation to date, against opening equity', async () => {
    const res = await api.post('/api/v1/fixed-assets', {
      factoryId: factory.id, name: 'Tata 1613 Truck', category: 'Vehicles', acquisitionType: 'EXISTING',
      acquisitionDate: '2026-04-01', costPaise: 1000000, method: 'WDV', ratePercent: 15, openingAccumulatedPaise: 400000,
    });
    expect(res.status).toBe(201);
    truck = res.body.data;
    expect(truck.bookValuePaise).toBe(600000);
    expect(truck.depreciatedUpTo).toBe('2026-03-31');
    expect(await balanceByCode('1590')).toBe(-400000);
  });

  it.each([
    ['straight line without a life', { method: 'SLM' }],
    ['WDV without a rate', { method: 'WDV' }],
    ['salvage at or above cost', { method: 'SLM', usefulLifeMonths: 12, salvageValuePaise: 1000 }],
    ['a purchase with no payment', { method: 'SLM', usefulLifeMonths: 12, payment: undefined }],
  ])('refuses %s', async (_label, overrides) => {
    const res = await api.post('/api/v1/fixed-assets', {
      factoryId: factory.id, name: 'Bad', category: 'Moulds', acquisitionType: 'PURCHASED', acquisitionDate: '2026-04-01',
      costPaise: 1000, payment: { mode: 'CASH' }, ...overrides,
    });
    expect(res.status).toBe(400);
  });
});

describe('Depreciation runs', () => {
  let april;
  let may;

  it('previews exactly what the run will post', async () => {
    const res = await api.get('/api/v1/fixed-assets/depreciation/preview', { factoryId: factory.id, upTo: '2026-04-30' });
    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.data.lines.map((l) => [l.assetId, l]));
    expect(byId[mould.id].amountPaise).toBe(98630);
    expect(byId[mould.id].days).toBe(30);
    expect(byId[truck.id].amountPaise).toBe(7397);
    expect(res.body.data.totalPaise).toBe(106027);
  });

  it('posts the run as depreciation against accumulated depreciation', async () => {
    const res = await api.post('/api/v1/fixed-assets/depreciation/runs', { factoryId: factory.id, upTo: '2026-04-30' });
    expect(res.status).toBe(201);
    april = res.body.data;
    expect(april.totalPaise).toBe(106027);
    expect(await balanceByCode('5800')).toBe(106027);
    expect(await balanceByCode('1590')).toBe(-(400000 + 106027));

    const asset = (await api.get(`/api/v1/fixed-assets/${mould.id}`)).body.data;
    expect(asset.accumulatedDepreciationPaise).toBe(98630);
    expect(asset.depreciatedUpTo).toBe('2026-04-30');
  });

  it('will not charge the same period twice', async () => {
    const res = await api.post('/api/v1/fixed-assets/depreciation/runs', { factoryId: factory.id, upTo: '2026-04-30' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Nothing to depreciate/);
  });

  it('continues from where the last run stopped, on the reduced WDV book value', async () => {
    const res = await api.post('/api/v1/fixed-assets/depreciation/runs', { factoryId: factory.id, upTo: '2026-05-31' });
    expect(res.status).toBe(201);
    may = res.body.data;
    const truckLine = may.lines.find((l) => l.assetId === truck.id);
    expect(truckLine.fromDate).toBe('2026-05-01');
    expect(truckLine.amountPaise).toBe(Math.round(((600000 - 7397) * 0.15 * 31) / 365));
  });

  it('undoes runs latest first only', async () => {
    const early = await api.put(`/api/v1/fixed-assets/depreciation/runs/${april.id}/cancel`, { reason: 'Wrong' });
    expect(early.status).toBe(400);
    expect(early.body.message).toMatch(/latest first/);

    const res = await api.put(`/api/v1/fixed-assets/depreciation/runs/${may.id}/cancel`, { reason: 'Rerun after rate check' });
    expect(res.status).toBe(200);
    const asset = (await api.get(`/api/v1/fixed-assets/${truck.id}`)).body.data;
    expect(asset.depreciatedUpTo).toBe('2026-04-30');
    expect(asset.accumulatedDepreciationPaise).toBe(400000 + 7397);
    expect(await balanceByCode('5800')).toBe(106027);
  });
});

describe('Disposal', () => {
  it('charges depreciation to the sale date, then books the gain', async () => {
    const extra = Math.round(((600000 - 7397) * 0.15 * 46) / 365); // 1 May – 15 Jun
    const accumulated = 400000 + 7397 + extra;
    const expectedGain = 650000 - (1000000 - accumulated);

    const bankBefore = await balanceByCode('1011');
    const res = await api.put(`/api/v1/fixed-assets/${truck.id}/dispose`, {
      disposedOn: '2026-06-15', proceedsPaise: 650000, payment: { mode: 'BANK', accountId: hdfc.id }, note: 'Sold to Sahu Transport',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('DISPOSED');
    expect(res.body.data.accumulatedDepreciationPaise).toBe(accumulated);
    expect(res.body.data.gainPaise).toBe(expectedGain);

    expect(await balanceByCode('1011')).toBe(bankBefore + 650000);
    expect(await balanceByCode('4950')).toBe(-expectedGain);
    // Only the mould is left on the books.
    expect(await balanceByCode('1500')).toBe(1200000);
    expect(await balanceByCode('1590')).toBe(-98630);
  });

  it('refuses to dispose twice', async () => {
    const res = await api.put(`/api/v1/fixed-assets/${truck.id}/dispose`, { disposedOn: '2026-06-20' });
    expect(res.status).toBe(400);
  });

  it('leaves disposed assets out of later runs', async () => {
    const res = await api.get('/api/v1/fixed-assets/depreciation/preview', { factoryId: factory.id, upTo: '2026-06-30' });
    expect(res.body.data.lines.map((l) => l.assetId)).toEqual([mould.id]);
  });

  it('keeps the balance sheet balanced, netting accumulated depreciation off cost', async () => {
    const res = await api.get('/api/v1/ledger/balance-sheet', { asOf: '2026-06-30', factoryId: factory.id });
    expect(res.body.data.differencePaise).toBe(0);
    const fixed = res.body.data.assets.find((s) => s.group === 'FIXED_ASSET');
    expect(fixed.totalPaise).toBe(1200000 - 98630);
  });
});
