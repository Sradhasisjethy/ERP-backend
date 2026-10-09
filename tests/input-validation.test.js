/**
 * Regression tests for the input-validation review (findings I1, I6, I8, I13).
 * Every rejected request here used to pass validation: a malformed or
 * timezone-shifted date, a string longer than its column, a number that is not
 * finite or not a safe integer, an unbounded array, free-form saved-report
 * params, and a query-string object reaching a master-data where clause.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { isIsoDate } = require('../src/utils/zodFields');
const { Tenant, User, Organization, Factory, FinancialYear } = require('../src/models/index');

const PASSWORD = 'password123';
const SOME_UUID = '00000000-0000-4000-8000-000000000001';

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

let T;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const tenant = await Tenant.create({ name: 'Validation Co', slug: 'validation-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Validation Pvt Ltd', code: 'VC' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'ACTIVE' });
  // Negative cash allowed so the positive control is not refused for an empty till.
  const factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant', code: 'VPL', state: 'Odisha', allowNegativeCash: true });
  await User.create(
    { tenantId, email: 'admin@validation.test', passwordHash, firstName: 'A', lastName: 'D', role: 'PLATFORM_ADMIN', status: 'ACTIVE' },
    { validate: false }
  );
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'admin@validation.test', password: PASSWORD });
  T = { org, factory, admin: extractCookie(login, 'accessToken') };
});

afterAll(async () => {
  await sequelize.close();
});

const post = (url, body) => request(app).post(url).set('Cookie', T.admin).send(body);
const expense = (overrides) => ({
  factoryId: T.factory.id, expenseDate: '2026-05-15', category: 'Diesel', mode: 'CASH', amountPaise: 1500, ...overrides,
});

describe('I1: business dates are real YYYY-MM-DD days', () => {
  it('isIsoDate accepts real days only', () => {
    expect(isIsoDate('2024-02-29')).toBe(true);
    expect(isIsoDate('2024-02-30')).toBe(false);
    expect(isIsoDate('2025-04-01T00:00:00+14:00')).toBe(false);
    expect(isIsoDate('0000-01-01')).toBe(false);
  });

  it.each([
    ['a timestamp with an offset', '2025-04-01T00:00:00+14:00'],
    ['text', 'abc'],
    ['a day that does not exist', '2024-02-30'],
  ])('refuses an expense dated with %s', async (_label, expenseDate) => {
    const res = await post('/api/v1/expenses', expense({ expenseDate }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/expenseDate must be a date in YYYY-MM-DD format/);
  });

  it('still records an expense with a plain YYYY-MM-DD date', async () => {
    const res = await post('/api/v1/expenses', expense({ description: 'Positive control' }));
    expect(res.status).toBe(201);
  });
});

describe('I8: strings, numbers and arrays are bounded', () => {
  it('refuses a factory name longer than its column', async () => {
    const res = await post('/api/v1/factories', { organizationId: T.org.id, name: 'a'.repeat(300), code: 'LONG' });
    expect(res.status).toBe(400);
  });

  it.each([['Infinity'], [1e20]])('refuses an amountPaise of %s', async (amountPaise) => {
    const res = await post('/api/v1/expenses', expense({ amountPaise }));
    expect(res.status).toBe(400);
  });

  it('refuses a sales order with more lines than the cap', async () => {
    const line = { productId: SOME_UUID, orderedQty: 1, ratePaise: 100 };
    const res = await post('/api/v1/sales/orders', {
      factoryId: T.factory.id, customerPartyId: SOME_UUID, orderDate: '2026-05-15',
      lines: Array.from({ length: 501 }, () => line),
    });
    expect(res.status).toBe(400);
  });
});

describe('I6: saved-report params are typed per report', () => {
  it('refuses a non-string search term', async () => {
    const res = await post('/api/v1/reports/run', { reportType: 'DOCUMENT_SEARCH', params: { q: 123 } });
    expect(res.status).toBe(400);
  });

  it('refuses a param the report does not read', async () => {
    const res = await post('/api/v1/reports/run', { reportType: 'DOCUMENT_SEARCH', params: { q: 'SO-1', where: { id: 1 } } });
    expect(res.status).toBe(400);
  });

  it('still runs with the params the report names', async () => {
    const res = await post('/api/v1/reports/run', { reportType: 'DOCUMENT_SEARCH', params: { q: 'SO-1', factoryId: T.factory.id } });
    expect(res.status).toBe(200);
  });
});

describe('I13: master-data export filters are scalar and known', () => {
  it('refuses an operator object in the query string', async () => {
    const res = await request(app).get('/api/v1/master-data/products/export?status[$ne]=x').set('Cookie', T.admin);
    expect(res.status).toBe(400);
  });

  it('refuses a filter no config reads', async () => {
    const res = await request(app).get('/api/v1/master-data/products/export?bogus=1').set('Cookie', T.admin);
    expect(res.status).toBe(400);
  });

  it('still exports with a plain status filter', async () => {
    const res = await request(app).get('/api/v1/master-data/products/export?status=active').set('Cookie', T.admin);
    expect(res.status).toBe(200);
  });
});
