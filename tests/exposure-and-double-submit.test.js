/**
 * Regression tests for findings A4, A5, A6 and A9 of 2026-10-09:
 *
 *  A4 — product cost/price rode along on stock, production, transfer and
 *       quality responses to roles without VIEW_RATES.
 *  A5 — AUDIT_READ returned every audit row: employees' personal details,
 *       login IPs and user agents, and unmasked money.
 *  A6 — the dashboard's money widgets were gated on VIEW_RATES alone.
 *  A9 — a double-click on Save created two financial documents.
 */
const { Op } = require('sequelize');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { stableStringify } = require('../src/middlewares/idempotency');
const { maskRateFields, hasViewRates } = require('../src/utils/fieldMasking');
const { clearDashboardCache } = require('../src/api/dashboard/dashboard.controller');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, StockLot,
  AdGroup, AdGroupMember, UserFactory, Expense, IdempotencyKey,
} = require('../src/models/index');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');


const MONEY_VALUE = /"(standardCostPaise|sellingPricePaise|openingStockRatePaise)":\s*\d/;

let X;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const tenant = await Tenant.create({ name: 'Exposure Co', slug: 'exposure-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Exposure Pvt Ltd', code: 'EX' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'ACTIVE' });
  const factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant', code: 'PL', state: 'Odisha', allowNegativeCash: true }); // the A9 expenses pay from an empty till
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  const product = await Product.create({
    tenantId, uomId: uom.id, name: 'Paver', code: 'FG-1', productType: 'FINISHED_GOOD',
    standardCostPaise: 4321, sellingPricePaise: 9876, openingStockRatePaise: 1111,
  });
  await StockLot.create({
    tenantId, factoryId: factory.id, productId: product.id, lotNumber: 'LOT-EX-1',
    originType: 'PRODUCTION', originId: factory.id, originDate: '2026-08-01',
    curingDays: 0, status: 'AVAILABLE', qtyOriginal: 10, qtyAvailable: 10,
  });

  const mk = (email, role = 'EMPLOYEE') =>
    User.create({ tenantId, email, passwordHash, firstName: 'F', lastName: 'L', role, status: 'ACTIVE' }, { validate: false });
  const grant = async (user, name, permissions) => {
    const group = await AdGroup.create({ tenantId, name, permissions, status: 'active' });
    await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });
    await UserFactory.create({ tenantId, userId: user.id, factoryId: factory.id });
  };

  await mk('admin@exposure.test', 'PLATFORM_ADMIN');
  const storeKeeper = await mk('store@exposure.test');
  await grant(storeKeeper, 'Store Keepers', ['INVENTORY_READ']);
  const accountant = await mk('accountant@exposure.test');
  await grant(accountant, 'Accountants', ['AUDIT_READ', 'EMPLOYEE_READ', 'EXPENSE_READ', 'LEDGER_READ']);
  const auditorOnly = await mk('auditor@exposure.test');
  await grant(auditorOnly, 'Auditors', ['AUDIT_READ']);
  const hr = await mk('hr@exposure.test');
  await grant(hr, 'HR', ['AUDIT_READ', 'EMPLOYEE_READ', 'EMPLOYEE_MODIFY']);
  const salesLead = await mk('sales@exposure.test');
  await grant(salesLead, 'Sales leads', ['VIEW_RATES', 'SALES_READ', 'PRODUCTION_READ']);
  const ledgerReader = await mk('ledger@exposure.test');
  await grant(ledgerReader, 'Ledger readers', ['VIEW_RATES', 'LEDGER_READ']);
  const employee = await mk('employee@exposure.test');

  X = { tenantId, factory, product, employee };
  X.admin = await loginAs('admin@exposure.test');
  X.store = await loginAs('store@exposure.test');
  X.accountant = await loginAs('accountant@exposure.test');
  X.auditor = await loginAs('auditor@exposure.test');
  X.hr = await loginAs('hr@exposure.test');
  X.sales = await loginAs('sales@exposure.test');
  X.ledger = await loginAs('ledger@exposure.test');
});

afterAll(async () => {
  await sequelize.close();
});

describe('A4: product money stays off stock screens without VIEW_RATES', () => {
  it('lists lots to a Store Keeper with the product named but no cost or price', async () => {
    const res = await request(app).get('/api/v1/inventory/lots').set('Cookie', X.store);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    expect(res.body.data.rows[0].product.name).toBe('Paver');
    expect(JSON.stringify(res.body.data)).not.toMatch(MONEY_VALUE);
  });

  it('keeps the money off the stock ledger and reservations too', async () => {
    for (const path of ['/api/v1/inventory/ledger', '/api/v1/inventory/reservations']) {
      const res = await request(app).get(path).set('Cookie', X.store);
      if (res.status === 200) expect(JSON.stringify(res.body.data)).not.toMatch(MONEY_VALUE);
    }
  });

  it('honours the * wildcard for VIEW_RATES, as authorize does', () => {
    expect(hasViewRates({ user: { role: 'EMPLOYEE', permissions: ['*'] } })).toBe(true);
    expect(hasViewRates({ user: { role: 'EMPLOYEE', permissions: ['INVENTORY_READ'] } })).toBe(false);
  });

  it('masks or drops money past the depth limit instead of returning it raw', () => {
    let deep = { amountPaise: 500 };
    for (let i = 0; i < 12; i += 1) deep = { child: deep };
    const masked = maskRateFields(deep, { user: { role: 'EMPLOYEE', permissions: [] } });
    expect(JSON.stringify(masked)).not.toMatch(/"amountPaise":\s*500/);
  });
});

describe('A5: the audit log shows only what the caller could read elsewhere', () => {
  beforeAll(async () => {
    const res = await request(app)
      .put(`/api/v1/users/${X.employee.id}`)
      .set('Cookie', X.admin)
      .send({ phone: '9876500000', address: '12 Private Lane', pincode: '751001', gender: 'Female' });
    expect(res.status).toBe(200);
  });

  it('withholds an employee\'s personal details from an accountant without EMPLOYEE_MODIFY', async () => {
    const res = await request(app).get('/api/v1/audit-logs?entityType=User&limit=100').set('Cookie', X.accountant);
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBeGreaterThan(0);
    const serialised = JSON.stringify(res.body.data.rows);
    expect(serialised).not.toContain('9876500000');
    expect(serialised).not.toContain('12 Private Lane');
    expect(serialised).not.toContain('751001');
  });

  it('shows the same details to HR, who can edit them anyway', async () => {
    const res = await request(app).get('/api/v1/audit-logs?entityType=User&limit=100').set('Cookie', X.hr);
    expect(JSON.stringify(res.body.data.rows)).toContain('9876500000');
  });

  it('nulls the IP and user agent of LOGIN rows for the accountant', async () => {
    const res = await request(app).get('/api/v1/audit-logs?entityType=Session&limit=100').set('Cookie', X.accountant);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
    for (const row of res.body.data.rows) {
      expect(row.ipAddress).toBeNull();
      expect(row.afterSnapshot.userAgent).toBeNull();
    }
  });

  it('excludes entity types the caller cannot read, in the count as well as the rows', async () => {
    const users = await request(app).get('/api/v1/audit-logs?entityType=User').set('Cookie', X.auditor);
    expect(users.status).toBe(200);
    expect(users.body.data.count).toBe(0);

    const all = await request(app).get('/api/v1/audit-logs?limit=100').set('Cookie', X.auditor);
    expect(all.body.data.rows.some((r) => ['User', 'Session', 'Product', 'StockLot'].includes(r.entityType))).toBe(false);
    expect(all.body.data.count).toBe(all.body.data.rows.length);
  });

  it('still shows a bypass role everything', async () => {
    const res = await request(app).get('/api/v1/audit-logs?entityType=Session&limit=100').set('Cookie', X.admin);
    expect(res.body.data.rows.some((r) => r.ipAddress)).toBe(true);
  });
});

describe('A6: dashboard money follows the module grants, not VIEW_RATES alone', () => {
  beforeEach(() => clearDashboardCache());

  it('gives VIEW_RATES without LEDGER_READ no financial section', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set('Cookie', X.sales);
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('financial');
    expect(res.body.data.scope.financial).toBe(false);
    // SALES_READ with VIEW_RATES still gets the sales half; no purchase series.
    expect(res.body.data).toHaveProperty('sales');
    expect(res.body.data.trends[0]).not.toHaveProperty('purchasePaise');
  });

  it('gives VIEW_RATES + LEDGER_READ the financial section without purchase figures or sales', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set('Cookie', X.ledger);
    expect(res.status).toBe(200);
    expect(res.body.data.financial).toHaveProperty('cashBalancePaise');
    expect(res.body.data.financial.purchaseMTDPaise).toBeNull();
    expect(res.body.data.financial.topVendors).toEqual([]);
    expect(res.body.data).not.toHaveProperty('sales');
  });
});

describe('A9: a double submit with the same Idempotency-Key creates one document', () => {
  // The guard is mounted in src/app.js and acts only on financial creates that
  // carry an Idempotency-Key (the SPA sends one per submission). Requests with
  // no key are untouched, so scripts and tests keep their exact behaviour.
  const body = () => ({
    factoryId: X.factory.id, expenseDate: '2026-08-20', category: 'Diesel', mode: 'CASH', amountPaise: 15000, description: 'Generator diesel',
  });
  const post = (payload, key) => {
    const r = request(app).post('/api/v1/expenses').set('Cookie', X.admin);
    return (key ? r.set('Idempotency-Key', key) : r).send(payload);
  };

  it('sorts keys recursively, so key order does not change the fingerprint', () => {
    expect(stableStringify({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: 2 } }))
      .toBe(stableStringify({ a: { c: 2, d: [1, { y: 2, z: 1 }] }, b: 1 }));
  });

  it('replays the first response for a repeat with the same key', async () => {
    const first = await post(body(), 'dbl-1');
    expect(first.status).toBe(201);
    const second = await post(body(), 'dbl-1');
    expect(second.status).toBe(201);
    expect(second.body.data.id).toBe(first.body.data.id);
    expect(second.headers['idempotent-replayed']).toBe('true');
    expect(await Expense.count({ where: { tenantId: X.tenantId, description: 'Generator diesel' } })).toBe(1);
  });

  it('refuses the same key reused for a different body', async () => {
    const res = await post({ ...body(), amountPaise: 99 }, 'dbl-1');
    expect(res.status).toBe(409);
  });

  it('allows the same key again once the window has passed', async () => {
    await sequelize.query(
      `UPDATE idempotency_keys SET "createdAt" = NOW() - INTERVAL '10 minutes', "updatedAt" = NOW() - INTERVAL '10 minutes'
        WHERE "tenantId" = :tenantId AND key LIKE 'client:%'`,
      { replacements: { tenantId: X.tenantId } }
    );
    const again = await post(body(), 'dbl-1');
    expect(again.status).toBe(201);
    expect(await Expense.count({ where: { tenantId: X.tenantId, description: 'Generator diesel' } })).toBe(2);
  });

  it('lets only one of two concurrent POSTs with the same key through', async () => {
    const payload = { ...body(), description: 'Concurrent diesel' };
    const results = await Promise.all([post(payload, 'dbl-2'), post(payload, 'dbl-2')]);
    for (const r of results) expect([201, 409]).toContain(r.status);
    expect(await Expense.count({ where: { tenantId: X.tenantId, description: 'Concurrent diesel' } })).toBe(1);
  });

  it('does not store a failed request, so a corrected retry goes through', async () => {
    const bad = { ...body(), amountPaise: 0, description: 'Bad diesel' };
    expect((await post(bad, 'dbl-3')).status).toBe(400);
    expect((await post(bad, 'dbl-3')).status).toBe(400);
  });

  it('leaves unauthenticated requests to authenticate, and claims nothing for them', async () => {
    const before = await IdempotencyKey.unscoped().count({ where: { tenantId: X.tenantId } });
    const res = await request(app).post('/api/v1/expenses').set('Idempotency-Key', 'dbl-4').send(body());
    expect(res.status).toBe(401);
    expect(await IdempotencyKey.unscoped().count({ where: { tenantId: X.tenantId } })).toBe(before);
  });

  it('does nothing for a request without a key: two identical POSTs make two documents', async () => {
    const payload = { ...body(), description: 'Keyless diesel' };
    expect((await post(payload)).status).toBe(201);
    expect((await post(payload)).status).toBe(201);
    expect(await Expense.count({ where: { tenantId: X.tenantId, description: 'Keyless diesel' } })).toBe(2);
    expect(await IdempotencyKey.unscoped().count({ where: { tenantId: X.tenantId, key: { [Op.like]: 'implicit:%' } } })).toBe(0);
  });
});
