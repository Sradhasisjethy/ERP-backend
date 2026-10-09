/**
 * Regression tests for the 2026-10-09 review findings C9, C12, C18, C20 and S2:
 * plant scope on the reads that missed it, the factory-assignment and
 * cross-tenant factory checks, the named grants for location policy and
 * year close, and the closed-year posting lock. Each refused request here
 * succeeded before the fix.
 */
const { Op } = require('sequelize');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Party, SalesOrder, DeliveryChallan,
  Account, JournalEntry, JournalLine, AdGroup, AdGroupMember, UserFactory,
} = require('../src/models/index');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

const as = (cookie) => ({
  get: (p) => request(app).get(p).set('Cookie', cookie),
  post: (p, b) => request(app).post(p).set('Cookie', cookie).send(b || {}),
  put: (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {}),
  patch: (p, b) => request(app).patch(p).set('Cookie', cookie).send(b || {}),
});

// Years relative to today, so the "current" one really contains today's date
// (reversals post with today's date).
const today = new Date().toISOString().slice(0, 10);
const [ty, tm] = today.split('-').map(Number);
const fyStart = tm >= 4 ? ty : ty - 1;
const fy = (start) => ({ code: `${start}-${String(start + 1).slice(2)}`, startDate: `${start}-04-01`, endDate: `${start + 1}-03-31` });
const CLOSED_YEAR = fy(fyStart - 2);
const SOFT_YEAR = fy(fyStart - 1);

let T;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const tenant = await Tenant.create({ name: 'Plant Scope Co', slug: 'plant-scope-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Plant Scope Pvt Ltd', code: 'PS' });

  await FinancialYear.create({ tenantId, ...fy(fyStart), isCurrent: true, status: 'ACTIVE' });
  await FinancialYear.create({ tenantId, ...SOFT_YEAR, status: 'SOFT_CLOSED' });
  const closedYear = await FinancialYear.create({ tenantId, ...CLOSED_YEAR, status: 'CLOSED' });
  const plannedYear = await FinancialYear.create({ tenantId, ...fy(fyStart + 3), status: 'PLANNED' });

  const plantA = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant A', code: 'PA', state: 'Odisha' });
  const plantB = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant B', code: 'PB', state: 'Odisha' });
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Shared Customer', state: 'Odisha' });

  // One order and challan per plant, written directly: only the read path is under test.
  const challanAt = async (factory, tag) => {
    const order = await SalesOrder.create({
      tenantId, factoryId: factory.id, orderNumber: `SO-${tag}`, customerPartyId: customer.id, orderDate: '2026-08-01', status: 'CONFIRMED',
    });
    return DeliveryChallan.create({
      tenantId, factoryId: factory.id, challanNumber: `DCSCOPE-${tag}`, salesOrderId: order.id, vehicleNumber: 'OD02AB1234', dispatchDate: '2026-08-02',
    });
  };
  const challanA = await challanAt(plantA, 'A');
  const challanB = await challanAt(plantB, 'B');

  // A receivable posting for the shared customer at each plant.
  const ar = await Account.create({ tenantId, code: '1100', name: 'Accounts Receivable', type: 'ASSET', isPartyControlAccount: true });
  const sales = await Account.create({ tenantId, code: '4000', name: 'Sales', type: 'INCOME' });
  const postAt = async (factory, amount) => {
    const entry = await JournalEntry.create({
      tenantId, factoryId: factory.id, entryDate: '2026-08-05', referenceType: 'SalesInvoice', referenceId: factory.id,
      narration: `Invoice at ${factory.code}`, totalDebitPaise: amount, totalCreditPaise: amount,
    });
    await JournalLine.create({ tenantId, journalEntryId: entry.id, accountId: ar.id, partyId: customer.id, debitPaise: amount, creditPaise: 0 });
    await JournalLine.create({ tenantId, journalEntryId: entry.id, accountId: sales.id, debitPaise: 0, creditPaise: amount });
  };
  await postAt(plantA, 1000);
  await postAt(plantB, 7000);

  const mk = (email, role = 'EMPLOYEE') =>
    User.create({ tenantId, email, passwordHash, firstName: 'F', lastName: 'L', role, status: 'ACTIVE' }, { validate: false });
  const grant = async (user, name, permissions) => {
    const group = await AdGroup.create({ tenantId, name, permissions });
    await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });
  };

  await mk('owner@plantscope.test', 'TENANT_OWNER');
  const staffA = await mk('staffa@plantscope.test');
  await grant(staffA, 'Plant A staff', [
    'DISPATCH_READ', 'LEDGER_READ', 'VIEW_RATES', 'ANALYTICS_READ', 'FACTORY_READ', 'FACTORY_CREATE',
  ]);
  await UserFactory.create({ tenantId, userId: staffA.id, factoryId: plantA.id });

  const locAdmin = await mk('locadmin@plantscope.test');
  await grant(locAdmin, 'Location admins', ['FACTORY_READ', 'FACTORY_CREATE', 'FACTORY_MODIFY']);
  const closer = await mk('closer@plantscope.test');
  await grant(closer, 'Year closers', ['FACTORY_READ', 'FACTORY_MODIFY', 'FINANCIAL_YEAR_CLOSE']);

  const rival = await Tenant.create({ name: 'Rival', slug: 'plant-scope-rival', status: 'active' });
  const rivalOrg = await Organization.create({ tenantId: rival.id, name: 'Rival Ltd', code: 'RV' });
  const rivalPlant = await Factory.create({ tenantId: rival.id, organizationId: rivalOrg.id, name: 'Rival Plant', code: 'RP', state: 'Odisha' });
  const rivalUser = await User.create(
    { tenantId: rival.id, email: 'user@plantscope-rival.test', passwordHash, firstName: 'R', lastName: 'R', role: 'EMPLOYEE', status: 'ACTIVE' },
    { validate: false }
  );

  T = { tenantId, plantA, plantB, customer, challanA, challanB, staffA, closedYear, plannedYear, rivalPlant, rivalUser };
  T.owner = await loginAs('owner@plantscope.test');
  T.staffACookie = await loginAs('staffa@plantscope.test');
  T.locAdminCookie = await loginAs('locadmin@plantscope.test');
  T.closerCookie = await loginAs('closer@plantscope.test');
});

afterAll(async () => {
  await sequelize.close();
});

describe('C9: plant scope on the reads that missed it', () => {
  it('hides another plant\'s challan PDF, and still prints your own', async () => {
    expect((await as(T.staffACookie).get(`/api/v1/dispatch/challans/${T.challanB.id}/print`)).status).toBe(404);
    expect((await as(T.staffACookie).get(`/api/v1/dispatch/challans/${T.challanA.id}/print`)).status).toBe(200);
  });

  it('limits a party statement and its outstanding figure to the caller\'s plants', async () => {
    const mine = await as(T.staffACookie).get(`/api/v1/ledger/party/${T.customer.id}?page=1&limit=50`);
    expect(mine.status).toBe(200);
    // One receivable line per plant was posted; only Plant A's comes back.
    expect(mine.body.data.rows).toHaveLength(1);
    expect(mine.body.data.rows[0].journalEntry.factoryId).toBe(T.plantA.id);
    expect(Number(mine.body.data.outstandingPaise)).toBe(1000);
    expect(Number(mine.body.data.closingBalancePaise)).toBe(1000);

    const all = await as(T.owner).get(`/api/v1/ledger/party/${T.customer.id}?page=1&limit=50`);
    expect(all.status).toBe(200);
    expect(all.body.data.rows).toHaveLength(2);
    expect(Number(all.body.data.outstandingPaise)).toBe(8000);
  });

  it('keeps another plant\'s documents out of document search', async () => {
    const res = await as(T.staffACookie).get('/api/v1/analytics/search?q=DCSCOPE');
    expect(res.status).toBe(200);
    const numbers = res.body.data.map((d) => d.number);
    expect(numbers).toContain('DCSCOPE-A');
    expect(numbers).not.toContain('DCSCOPE-B');
  });
});

describe('C18: assigning users to a plant', () => {
  it('refuses a FACTORY_CREATE holder joining a plant they cannot use', async () => {
    const res = await as(T.staffACookie).post(`/api/v1/factories/${T.plantB.id}/users`, { userId: T.staffA.id });
    expect(res.status).toBe(403);
    expect(await UserFactory.count({ where: { userId: T.staffA.id, factoryId: T.plantB.id } })).toBe(0);
  });

  it('refuses linking another tenant\'s user into this tenant\'s plant', async () => {
    const res = await as(T.owner).post(`/api/v1/factories/${T.plantA.id}/users`, { userId: T.rivalUser.id });
    expect(res.status).toBe(404);
  });
});

describe('C20: a bypass role cannot name another tenant\'s factory', () => {
  it('404s a list filtered to a foreign factory', async () => {
    expect((await as(T.owner).get(`/api/v1/expenses?factoryId=${T.rivalPlant.id}`)).status).toBe(404);
  });

  it('404s a document raised against a foreign factory', async () => {
    const res = await as(T.owner).post('/api/v1/expenses', {
      factoryId: T.rivalPlant.id, expenseDate: today, category: 'Diesel', mode: 'BANK', amountPaise: 500,
    });
    expect(res.status).toBe(404);
  });
});

describe('C12: location policy and financial-year close need their own grants', () => {
  it('refuses a policy change to FACTORY_MODIFY alone', async () => {
    const res = await as(T.locAdminCookie).put(`/api/v1/factories/${T.plantA.id}`, { varianceThresholdPercent: 100 });
    expect(res.status).toBe(403);
    await T.plantA.reload();
    expect(Number(T.plantA.varianceThresholdPercent)).toBe(5);
  });

  it('still lets FACTORY_MODIFY rename a plant, and re-save the form unchanged', async () => {
    const renamed = await as(T.locAdminCookie).put(`/api/v1/factories/${T.plantA.id}`, { name: 'Plant A North' });
    expect(renamed.status).toBe(200);

    // What the factory form sends: every checkbox, at its current value.
    const resaved = await as(T.locAdminCookie).put(`/api/v1/factories/${T.plantA.id}`, {
      name: 'Plant A North', allowNegativeStock: false, allowNegativeCash: false, qcHoldEnabled: false,
    });
    expect(resaved.status).toBe(200);
  });

  it('lets a tenant owner change the policy', async () => {
    const res = await as(T.owner).put(`/api/v1/factories/${T.plantB.id}`, { dispatchTolerancePercent: 2 });
    expect(res.status).toBe(200);
  });

  it('refuses closing or rolling over a year without FINANCIAL_YEAR_CLOSE', async () => {
    const close = await as(T.locAdminCookie).patch(`/api/v1/financial-years/${T.plannedYear.id}/status`, { status: 'CLOSED' });
    expect(close.status).toBe(403);
    const rollover = await as(T.locAdminCookie).put(`/api/v1/financial-years/${T.plannedYear.id}/set-current`);
    expect(rollover.status).toBe(403);
    await T.plannedYear.reload();
    expect(T.plannedYear.status).toBe('PLANNED');
  });

  it('lets the grant holder close it', async () => {
    const res = await as(T.closerCookie).patch(`/api/v1/financial-years/${T.plannedYear.id}/status`, { status: 'CLOSED' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CLOSED');
  });
});

describe('S2: the books of a CLOSED year are locked', () => {
  const expense = (expenseDate) => ({
    factoryId: T.plantA.id, expenseDate, category: 'Diesel', mode: 'BANK', amountPaise: 1500,
  });

  it('refuses a posting dated inside a closed year', async () => {
    const res = await as(T.owner).post('/api/v1/expenses', expense(`${fyStart - 2}-06-15`));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/closed financial year/);
    expect(await JournalEntry.count({ where: { entryDate: `${fyStart - 2}-06-15` } })).toBe(0);
  });

  it('still accepts one dated inside a soft-closed year', async () => {
    const res = await as(T.owner).post('/api/v1/expenses', expense(`${fyStart - 1}-06-15`));
    expect(res.status).toBe(201);
    T.softYearExpense = res.body.data;
  });

  it('still cancels a document once its year is closed — the reversal posts today', async () => {
    const softYear = await FinancialYear.findOne({ where: { code: SOFT_YEAR.code } });
    await softYear.update({ status: 'CLOSED' });

    const res = await as(T.owner).put(`/api/v1/expenses/${T.softYearExpense.id}/cancel`, { reason: 'Booked twice' });
    expect(res.status).toBe(200);
    const reversal = await JournalEntry.findOne({ where: { referenceId: T.softYearExpense.id, reversalOfEntryId: { [Op.ne]: null } } });
    expect(reversal.entryDate).toBe(today);
  });
});
