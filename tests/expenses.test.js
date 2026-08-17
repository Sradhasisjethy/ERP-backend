const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, Factory, FinancialYear, Party } = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;
let factory;
let vendor;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-expenses', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@expenses-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Expenses Factory', code: 'EXP-FAC' });
  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Diesel Vendor' });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@expenses-test.co', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('Expense management (M28, BR-18)', () => {
  it('posts a balanced journal (Debit FACTORY_EXPENSE, Credit BANK) for a BANK-mode expense', async () => {
    const res = await request(app)
      .post('/api/v1/expenses')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id, expenseDate: '2026-08-20', category: 'Diesel', mode: 'BANK', amountPaise: 15000, paidToPartyId: vendor.id, description: 'Generator diesel refill',
      });
    expect(res.status).toBe(201);
    expect(res.body.data.expenseNumber).toMatch(/^EXP\//);
    expect(res.body.data.status).toBe('POSTED');

    const trialBalance = await request(app).get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`).set('Cookie', adminCookie);
    expect(trialBalance.status).toBe(200);
    const expenseAccount = trialBalance.body.data.find((row) => row.code === '5900');
    expect(expenseAccount.balancePaise).toBe(15000);
  });

  it('rejects a non-positive amount', async () => {
    const res = await request(app)
      .post('/api/v1/expenses')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, expenseDate: '2026-08-20', category: 'Diesel', mode: 'BANK', amountPaise: 0 });
    expect(res.status).toBe(400);
  });

  it('lists expenses filtered by factory', async () => {
    const res = await request(app).get(`/api/v1/expenses?factoryId=${factory.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
  });

  it('cancels a POSTED expense and reverses its journal entry', async () => {
    const created = await request(app)
      .post('/api/v1/expenses')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, expenseDate: '2026-08-21', category: 'Repairs', mode: 'BANK', amountPaise: 5000 });

    const cancelled = await request(app)
      .put(`/api/v1/expenses/${created.body.data.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Duplicate entry' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const trialBalance = await request(app).get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`).set('Cookie', adminCookie);
    const expenseAccount = trialBalance.body.data.find((row) => row.code === '5900');
    // Only the first (still-posted) 15000 expense should remain net of the reversed 5000 one.
    expect(expenseAccount.balancePaise).toBe(15000);
  });

  it('rejects cancelling an already-cancelled expense', async () => {
    const list = await request(app).get(`/api/v1/expenses?factoryId=${factory.id}&category=Repairs`).set('Cookie', adminCookie);
    const cancelledExpense = list.body.data.rows[0];
    const res = await request(app)
      .put(`/api/v1/expenses/${cancelledExpense.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Retry' });
    expect(res.status).toBe(400);
  });
});
