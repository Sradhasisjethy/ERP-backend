/**
 * Regression tests for the 2026-10-09 input-handling review: bad input is a
 * 400, not a 500 (I9), and the closed-year check reads the same calendar day
 * the database stores (I1). Synthetic data only.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { LedgerService } = require('../src/api/ledger/ledger.service');
const { Tenant, User, Organization, Factory, FinancialYear } = require('../src/models/index');

const PASSWORD = 'password123';
let T;

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Mapping Co', slug: 'mapping-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Mapping Pvt Ltd', code: 'MP' });
  await User.create(
    { tenantId, email: 'admin@mapping.test', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'A', lastName: 'A', role: 'PLATFORM_ADMIN', status: 'ACTIVE' },
    { validate: false }
  );
  const factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant', code: 'PL', state: 'Odisha' });
  await FinancialYear.create({ tenantId, code: '2024-25', startDate: '2024-04-01', endDate: '2025-03-31', isCurrent: false, status: 'CLOSED' });
  await FinancialYear.create({ tenantId, code: '2025-26', startDate: '2025-04-01', endDate: '2026-03-31', isCurrent: true, status: 'ACTIVE' });

  const login = await request(app).post('/api/v1/auth/login').send({ email: 'admin@mapping.test', password: PASSWORD });
  const cookie = (login.headers['set-cookie'] || []).find((c) => c.startsWith('accessToken=')).split(';')[0];
  T = { factory, cookie };
});

afterAll(async () => {
  await sequelize.close();
});

describe('I9: malformed input is a client error', () => {
  it('answers 400, not 500, for a non-UUID id', async () => {
    const res = await request(app).get('/api/v1/sales/orders/not-a-uuid').set('Cookie', T.cookie);
    expect([400, 404]).toContain(res.status);
  });

  it('answers 400 for a body that is not JSON', async () => {
    const res = await request(app).post('/api/v1/expenses').set('Cookie', T.cookie)
      .set('Content-Type', 'application/json').send('{bad');
    expect(res.status).toBe(400);
  });

  it('answers 400 when a value is too long for its column', async () => {
    const res = await request(app).post('/api/v1/factories').set('Cookie', T.cookie)
      .send({ organizationId: T.factory.organizationId, name: 'x'.repeat(300), code: 'LONG' });
    expect(res.status).toBe(400);
  });
});

describe('I1: the closed-year check reads the day that is stored', () => {
  const check = (date) => sequelize.transaction((transaction) => LedgerService.assertPeriodOpen(T.factory.id, date, transaction));

  it('refuses a timestamp that lands in the closed year', async () => {
    // Read naively this is 1 April (open year); it is stored as 31 March.
    await expect(check('2025-04-01T00:00:00+14:00')).rejects.toThrow(/closed financial year/);
  });

  it('refuses an unparseable date and accepts a plain open-year date', async () => {
    await expect(check('not-a-date')).rejects.toThrow(/not a valid date/);
    await expect(check('2025-04-01')).resolves.toBeUndefined();
    await expect(check('2025-03-31')).rejects.toThrow(/closed financial year/);
  });
});
