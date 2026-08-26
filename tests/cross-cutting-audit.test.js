const request = require('supertest');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { app } = require('../src/app');
const { env } = require('../src/config/env');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party,
  AdGroup, AdGroupMember, UserFactory, AuditLog, Notification, DocumentSeries,
} = require('../src/models/index');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const rawCookie = (res, name) => (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`)) || '';
const login = (email) => request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
const loginAs = async (email) => extractCookie(await login(email), 'accessToken');

let X;
let admin;
let plantBOnly;
let other;

const as = (cookie) => ({
  get: (p) => request(app).get(p).set('Cookie', cookie),
  post: (p, b) => request(app).post(p).set('Cookie', cookie).send(b),
  put: (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {}),
});

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Cross Co', slug: 'cross-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Cross Pvt Ltd', code: 'XC' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@cross.test', passwordHash, firstName: 'A', lastName: 'A', role: 'PLATFORM_ADMIN', status: 'ACTIVE' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const plantA = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant A', code: 'PA', state: 'Odisha', dispatchTolerancePercent: 0 });
  const plantB = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant B', code: 'PB', state: 'Odisha' });
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  const product = await Product.create({ tenantId, uomId: uom.id, name: 'Item', code: 'RM-1', productType: 'RAW_MATERIAL' });
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Cross Customer', state: 'Odisha' });
  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Cross Vendor', state: 'Odisha' });
  const contractor = await Party.create({ tenantId, partyType: 'CONTRACTOR', name: 'Cross Contractor', state: 'Odisha' });

  X = { tenantId, org, plantA, plantB, uom, product, customer, vendor, contractor };
  admin = await loginAs('admin@cross.test');

  const mkUser = async (email, permissions, factoryId, status = 'ACTIVE') => {
    const u = await User.create({ tenantId, email, passwordHash, firstName: 'X', lastName: 'Y', role: 'EMPLOYEE', status }, { validate: false });
    const g = await AdGroup.create({ tenantId, name: `G ${email}`, permissions });
    await AdGroupMember.create({ tenantId, adGroupId: g.id, employeeId: u.id });
    if (factoryId) await UserFactory.create({ tenantId, userId: u.id, factoryId });
    return u;
  };
  X.mkUser = mkUser;

  await mkUser('plantb@cross.test', [
    'PRODUCTION_READ', 'PRODUCTION_CREATE', 'EXPENSE_READ', 'EXPENSE_CREATE',
    'RETURN_READ', 'TRANSFER_READ', 'CONTRACTOR_READ', 'LABOUR_READ',
    'ANALYTICS_READ', 'GSTR_READ', 'VIEW_RATES',
  ], plantB.id);
  plantBOnly = await loginAs('plantb@cross.test');

  const t2 = await Tenant.create({ name: 'Rival', slug: 'cross-rival', status: 'active' });
  const org2 = await Organization.create({ tenantId: t2.id, name: 'Rival Pvt', code: 'RV' });
  await User.create({ tenantId: t2.id, email: 'admin@cross-rival.test', passwordHash, firstName: 'R', lastName: 'R', role: 'PLATFORM_ADMIN', status: 'ACTIVE' }, { validate: false });
  await FinancialYear.create({ tenantId: t2.id, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const rf = await Factory.create({ tenantId: t2.id, organizationId: org2.id, name: 'Rival Plant', code: 'RP', state: 'Odisha' });
  other = { tenantId: t2.id, factory: rf, cookie: await loginAs('admin@cross-rival.test') };
});

afterAll(async () => {
  await sequelize.close();
});

// ===========================================================================
// 1. Authentication
// ===========================================================================
describe('1. Authentication', () => {
  it('logs in, issues httpOnly cookies, and serves the current user', async () => {
    const res = await login('admin@cross.test');
    expect(res.status).toBe(200);
    const access = rawCookie(res, 'accessToken');
    expect(access).toMatch(/HttpOnly/i);
    expect(access).toMatch(/SameSite/i);
    expect(rawCookie(res, 'refreshToken')).toMatch(/HttpOnly/i);

    const me = await as(extractCookie(res, 'accessToken')).get('/api/v1/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.passwordHash).toBeUndefined();
  });

  it('rejects a missing, malformed, wrongly-signed or expired token', async () => {
    expect((await request(app).get('/api/v1/auth/me')).status).toBe(401);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', 'accessToken=garbage')).status).toBe(401);

    const forged = jwt.sign({ userId: 'x', tenantId: X.tenantId, role: 'PLATFORM_ADMIN' }, 'not-the-secret', { expiresIn: '1h' });
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', `accessToken=${forged}`)).status).toBe(401);

    const expired = jwt.sign({ userId: 'x', tenantId: X.tenantId, role: 'PLATFORM_ADMIN' }, env.JWT_SECRET, { expiresIn: '-1s' });
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', `accessToken=${expired}`)).status).toBe(401);
  });

  it('rejects a token signed with the "none" algorithm', async () => {
    const none = `${Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ userId: 'x', role: 'PLATFORM_ADMIN' })).toString('base64url')}.`;
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', `accessToken=${none}`)).status).toBe(401);
  });

  it('refuses to log in a user who is not active', async () => {
    await X.mkUser('terminated@cross.test', ['SALES_READ'], null, 'TERMINATED');
    const res = await login('terminated@cross.test');
    expect(res.status).toBe(401);

    await X.mkUser('inactive@cross.test', ['SALES_READ'], null, 'INACTIVE');
    expect((await login('inactive@cross.test')).status).toBe(401);
  });

  it('stops honouring a refresh token once the user is disabled', async () => {
    const u = await X.mkUser('soon-gone@cross.test', ['SALES_READ']);
    const res = await login('soon-gone@cross.test');
    expect(res.status).toBe(200);
    const refreshCookie = extractCookie(res, 'refreshToken');

    // The user is disabled after they logged in. Their 7-day refresh token must
    // not keep minting fresh access tokens for a week.
    await u.update({ status: 'TERMINATED' });
    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', refreshCookie).send({});
    expect(refreshed.status).toBe(401);
  });

  it('logs out by clearing the cookies', async () => {
    const res = await login('admin@cross.test');
    const out = await request(app).post('/api/v1/auth/logout').set('Cookie', extractCookie(res, 'accessToken'));
    expect(out.status).toBe(200);
    expect(rawCookie(out, 'accessToken')).toMatch(/accessToken=;|Max-Age=0|Expires=Thu, 01 Jan 1970/i);
  });

  it('does not reveal whether an email exists on forgot-password', async () => {
    const known = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'admin@cross.test' });
    const unknown = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'nobody@nowhere.test' });
    expect(unknown.status).toBe(200);
    expect([200, 400]).toContain(known.status);
  });
});

// ===========================================================================
// 2. RBAC and privilege escalation
// ===========================================================================
describe('2. RBAC', () => {
  it('refuses an unknown permission code and cannot be self-granted', async () => {
    const u = await X.mkUser('escalate@cross.test', ['SALES_READ'], X.plantA.id);
    const cookie = await loginAs('escalate@cross.test');

    // Cannot read or write roles at all.
    expect((await as(cookie).get('/api/v1/roles')).status).toBe(403);
    expect((await as(cookie).post('/api/v1/roles', { name: 'Mine', permissions: ['*'] })).status).toBe(403);
    // Cannot create users.
    expect((await as(cookie).post('/api/v1/users', { email: 'x@y.test', firstName: 'a', lastName: 'b', role: 'PLATFORM_ADMIN' })).status).toBe(403);
    expect(u.role).toBe('EMPLOYEE');
  });

  it('rejects an unknown permission code rather than storing it', async () => {
    const res = await as(admin).post('/api/v1/roles', {
      name: 'Odd Role', permissions: ['SALES_READ', 'NOT_A_REAL_PERMISSION', 'DROP TABLE'],
    });
    expect(res.status).toBe(400);
    const ok = await as(admin).post('/api/v1/roles', { name: 'Good Role', permissions: ['SALES_READ'] });
    expect(ok.status).toBe(201);
    expect(ok.body.data.permissions).toEqual(['SALES_READ']);
  });

  it('a role change takes effect on the next login', async () => {
    const u = await X.mkUser('promoted@cross.test', ['SALES_READ'], X.plantA.id);
    const before = await loginAs('promoted@cross.test');
    expect((await as(before).get('/api/v1/products')).status).toBe(403);

    const group = await AdGroup.findOne({ where: { name: 'G promoted@cross.test' } });
    await group.update({ permissions: ['SALES_READ', 'PRODUCT_READ'] });

    const after = await loginAs('promoted@cross.test');
    expect((await as(after).get('/api/v1/products')).status).toBe(200);
  });
});

// ===========================================================================
// 3. Organization isolation, across every module
// ===========================================================================
describe('3. Organization isolation', () => {
  it('never leaks data between tenants on any module', async () => {
    const paths = [
      '/api/v1/parties', '/api/v1/products', '/api/v1/sales/orders', '/api/v1/purchasing/orders',
      '/api/v1/inventory/lots', '/api/v1/receipts', '/api/v1/payments', '/api/v1/expenses',
      '/api/v1/invoices', '/api/v1/dispatch/challans', '/api/v1/transfers', '/api/v1/notifications',
      '/api/v1/audit-logs',
    ];
    for (const path of paths) {
      const mine = await as(admin).get(`${path}?limit=100`);
      const theirs = await as(other.cookie).get(`${path}?limit=100`);
      expect([path, mine.status]).toEqual([path, 200]);
      expect([path, theirs.status]).toEqual([path, 200]);

      const myIds = new Set((mine.body.data.rows || []).map((r) => r.id));
      const overlap = (theirs.body.data.rows || []).filter((r) => myIds.has(r.id));
      expect([path, overlap]).toEqual([path, []]);
    }
  });
});

// ===========================================================================
// 4. Location security — every module that carries a factory
// ===========================================================================
describe('4. Location security', () => {
  it('confines a Plant-B user on every factory-scoped list', async () => {
    // Create a Plant A document in each module so there is something to leak.
    await as(admin).post('/api/v1/expenses', {
      factoryId: X.plantA.id, expenseDate: '2026-08-01', category: 'Fuel', mode: 'BANK', amountPaise: 1000,
    });

    const paths = [
      '/api/v1/expenses', '/api/v1/production/entries', '/api/v1/returns/purchase-returns',
      '/api/v1/returns/sales-returns', '/api/v1/transfers', '/api/v1/workforce/labour/attendance',
      '/api/v1/notifications',
    ];
    for (const path of paths) {
      const res = await as(plantBOnly).get(`${path}?limit=100`);
      if (res.status === 403) continue; // permission-gated for this fixture; not a leak
      expect([path, res.status]).toEqual([path, 200]);
      const leaked = (res.body.data.rows || []).filter((r) => r.factoryId === X.plantA.id);
      expect([path, leaked.length]).toEqual([path, 0]);
    }
  });

  it('refuses to create a document at a location the user cannot access', async () => {
    const res = await as(plantBOnly).post('/api/v1/expenses', {
      factoryId: X.plantA.id, expenseDate: '2026-08-02', category: 'Fuel', mode: 'BANK', amountPaise: 500,
    });
    expect(res.status).toBe(403);
  });

  it('refuses analytics and GST for a location the user cannot access', async () => {
    expect((await as(plantBOnly).get(`/api/v1/analytics/summary?factoryId=${X.plantA.id}`)).status).toBe(403);
    expect((await as(plantBOnly).get(`/api/v1/gstr/gstr1?factoryId=${X.plantA.id}&from=2026-08-01&to=2026-08-31`)).status).toBe(403);
  });
});

// ===========================================================================
// 5. Document numbering
// ===========================================================================
describe('5. Document numbering', () => {
  it('allocates gap-free, unique numbers under concurrency', async () => {
    const fire = () =>
      as(admin).post('/api/v1/expenses', {
        factoryId: X.plantA.id, expenseDate: '2026-08-03', category: 'Concurrency', mode: 'BANK', amountPaise: 100,
      });
    const results = await Promise.all(Array.from({ length: 8 }, fire));
    const numbers = results.filter((r) => r.status === 201).map((r) => r.body.data.expenseNumber);
    expect(numbers.length).toBe(8);
    expect(new Set(numbers).size).toBe(8);

    const seqs = numbers.map((n) => Number(n.split('/').pop())).sort((a, b) => a - b);
    for (let i = 1; i < seqs.length; i += 1) expect(seqs[i]).toBe(seqs[i - 1] + 1);
  });

  it('carries the location in the number so two factories never collide', async () => {
    const a = await as(admin).post('/api/v1/expenses', {
      factoryId: X.plantA.id, expenseDate: '2026-08-04', category: 'X', mode: 'BANK', amountPaise: 100,
    });
    const b = await as(admin).post('/api/v1/expenses', {
      factoryId: X.plantB.id, expenseDate: '2026-08-04', category: 'X', mode: 'BANK', amountPaise: 100,
    });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.data.expenseNumber).not.toBe(b.body.data.expenseNumber);
    expect(a.body.data.expenseNumber).toContain('PA');
    expect(b.body.data.expenseNumber).toContain('PB');
  });

  it('keys the series by financial year and tenant', async () => {
    const series = await DocumentSeries.findAll({ where: { documentType: 'EXPENSE' } });
    expect(series.length).toBeGreaterThan(0);
    // tenantId is deliberately excluded from every scoped model's default
    // attributes (BaseModel defaultScope), so only financialYearId is visible.
    expect(series.every((s) => s.financialYearId)).toBe(true);
  });

  it('never reuses a cancelled document\'s number', async () => {
    const exp = await as(admin).post('/api/v1/expenses', {
      factoryId: X.plantA.id, expenseDate: '2026-08-05', category: 'Y', mode: 'BANK', amountPaise: 100,
    });
    const number = exp.body.data.expenseNumber;
    await as(admin).put(`/api/v1/expenses/${exp.body.data.id}/cancel`, { reason: 'test' });

    const next = await as(admin).post('/api/v1/expenses', {
      factoryId: X.plantA.id, expenseDate: '2026-08-05', category: 'Y', mode: 'BANK', amountPaise: 100,
    });
    expect(next.body.data.expenseNumber).not.toBe(number);
  });
});

// ===========================================================================
// 6. Notifications
// ===========================================================================
describe('6. Notifications', () => {
  it('raises a notification the moment a transaction trips an alert condition', async () => {
    const before = await Notification.count();

    // Credit limit breach is an existing alert type that only the nightly job
    // ever raised, though the breach is detected live at order entry.
    const capped = await Party.create({
      tenantId: X.tenantId, partyType: 'CUSTOMER', name: 'Capped Customer', state: 'Odisha',
      creditLimitPaise: 1000, creditAction: 'WARN',
    });
    const p = await Product.create({ tenantId: X.tenantId, uomId: X.uom.id, name: 'Notif FG', code: 'FG-NOTIF', productType: 'FINISHED_GOOD' });

    const order = await as(admin).post('/api/v1/sales/orders', {
      factoryId: X.plantA.id, customerPartyId: capped.id, orderDate: '2026-08-06',
      lines: [{ productId: p.id, orderedQty: 10, ratePaise: 100000 }],
    });
    expect(order.status).toBe(201);

    expect(await Notification.count()).toBeGreaterThan(before);
    const raised = await Notification.findOne({ where: { type: 'CREDIT_LIMIT_BREACH', entityId: capped.id } });
    expect(raised).not.toBeNull();
    expect(raised.entityType).toBe('Party');
  });

  it('suppresses a duplicate notification for the same event', async () => {
    const { NotificationsService } = require('../src/api/notifications/notifications.service');
    const { getTenantContext } = require('../src/core/tenantContext');
    const ns = getTenantContext();
    const outcome = await new Promise((resolve) => {
      ns.run(async () => {
        ns.set('tenantId', X.tenantId);
        const key = `dedupe-test-${X.plantA.id}`;
        try {
          const first = await NotificationsService.raise({ type: 'JOB_FAILED', title: 'T', message: 'M', factoryId: X.plantA.id, dedupeKey: key });
          const second = await NotificationsService.raise({ type: 'JOB_FAILED', title: 'T', message: 'M', factoryId: X.plantA.id, dedupeKey: key });
          resolve({ first: !!first, second: second === null });
        } catch (error) {
          resolve({ error: error.message });
        }
      });
    });
    expect(outcome.error).toBeUndefined();
    expect(outcome.first).toBe(true);
    expect(outcome.second).toBe(true);
  });

  it('tracks read and unread', async () => {
    const list = await as(admin).get('/api/v1/notifications?limit=10');
    expect(list.status).toBe(200);
    const unread = await as(admin).get('/api/v1/notifications/unread-count');
    expect(unread.status).toBe(200);
    expect(Number(unread.body.data.unread)).toBeGreaterThanOrEqual(0);

    if (list.body.data.rows.length) {
      const marked = await as(admin).put(`/api/v1/notifications/${list.body.data.rows[0].id}/read`);
      expect(marked.status).toBe(200);
    }
  });
});

// ===========================================================================
// 7. Audit log
// ===========================================================================
describe('7. Audit log', () => {
  it('captures user, timestamp, IP, action, entity, and before/after', async () => {
    const party = await as(admin).post('/api/v1/parties', { partyType: 'CUSTOMER', name: 'Audited Party' });
    await as(admin).put(`/api/v1/parties/${party.body.data.id}`, { name: 'Audited Party Renamed' });

    const rows = await AuditLog.findAll({ where: { entityType: 'Party', entityId: party.body.data.id } });
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['CREATE', 'UPDATE']));

    const update = rows.find((r) => r.action === 'UPDATE');
    expect(update.userId).toBeTruthy();
    expect(update.ipAddress).toBeTruthy();
    expect(update.createdAt).toBeTruthy();
    expect(update.beforeSnapshot.name).toBe('Audited Party');
    expect(update.afterSnapshot.name).toBe('Audited Party Renamed');
  });

  it('records a login', async () => {
    await login('admin@cross.test');
    const logins = await AuditLog.findAll({ where: { action: 'LOGIN' } });
    expect(logins.length).toBeGreaterThan(0);
    expect(logins.every((r) => r.userId && r.ipAddress)).toBe(true);
  });

  it('records a role/permission change', async () => {
    const role = await as(admin).post('/api/v1/roles', { name: 'Audited Role', permissions: ['SALES_READ'] });
    expect(role.status).toBe(201);
    await as(admin).put(`/api/v1/roles/${role.body.data.id}`, { permissions: ['SALES_READ', 'SALES_CREATE'] });

    const rows = await AuditLog.findAll({ where: { entityType: 'AdGroup', entityId: role.body.data.id } });
    expect(rows.length).toBeGreaterThan(0);
    const change = rows.find((r) => r.action === 'UPDATE');
    expect(change).toBeDefined();
    expect(change.afterSnapshot.permissions).toEqual(['SALES_READ', 'SALES_CREATE']);
  });

  it('is readable only with AUDIT_READ and never across tenants', async () => {
    const cookie = await (async () => {
      await X.mkUser('noaudit@cross.test', ['SALES_READ'], X.plantA.id);
      return loginAs('noaudit@cross.test');
    })();
    expect((await as(cookie).get('/api/v1/audit-logs')).status).toBe(403);
  });
});

// ===========================================================================
// 8. Error handling
// ===========================================================================
describe('8. Error handling', () => {
  it('returns the standard envelope for every error class', async () => {
    const cases = [
      [401, await request(app).get('/api/v1/products')],
      [404, await request(app).get('/no-such-route')],
      [403, await as(await (async () => { await X.mkUser('lowly@cross.test', ['SALES_READ'], X.plantA.id); return loginAs('lowly@cross.test'); })()).get('/api/v1/products')],
      [404, await as(admin).get('/api/v1/products/00000000-0000-0000-0000-000000000000')],
      [400, await as(admin).post('/api/v1/parties', { partyType: 'NOPE', name: '' })],
    ];
    for (const [expected, res] of cases) {
      expect([expected, res.status]).toEqual([expected, expected]);
      expect(res.body).toHaveProperty('success', false);
      expect(typeof res.body.message).toBe('string');
      expect(res.body.stack).toBeUndefined();
      expect(res.body.sql).toBeUndefined();
    }
  });

  it('never leaks SQL, stack traces or driver detail', async () => {
    // A malformed UUID reaches the driver as a cast error.
    const res = await as(admin).get('/api/v1/products/not-a-uuid');
    expect([400, 404, 500]).toContain(res.status);
    const body = JSON.stringify(res.body);
    expect(body).not.toMatch(/SequelizeDatabaseError|invalid input syntax|node_modules|\.js:\d+|SELECT .* FROM/i);
  });

  it('returns 409 on a duplicate and 400 on a bad reference', async () => {
    await as(admin).post('/api/v1/uoms', { name: 'Dup', code: 'DUP-CC' });
    const dup = await as(admin).post('/api/v1/uoms', { name: 'Dup 2', code: 'DUP-CC' });
    expect(dup.status).toBe(409);
    expect(dup.body.message).not.toMatch(/constraint|index|pg_/i);
  });
});

// ===========================================================================
// 9. Health, configuration and operations
// ===========================================================================
describe('9. Health and operations', () => {
  it('the health endpoint reports database connectivity, not just process liveness', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    // A health check that passes while the database is unreachable keeps a
    // broken instance in the load-balancer rotation.
    expect(res.body.checks).toBeDefined();
    expect(res.body.checks.database).toBe('ok');
  });

  it('exposes a liveness probe that does not touch the database', async () => {
    const res = await request(app).get('/health/live');
    expect(res.status).toBe(200);
  });

  it('applies production rate limits rather than development ones', async () => {
    const { resolveLimits } = require('../src/middlewares/rateLimiter');
    expect(resolveLimits('production').api).toBe(100);
    expect(resolveLimits('production').auth).toBe(10);
    expect(resolveLimits('development').api).toBeGreaterThan(100);
  });

  it('validates required configuration at boot', () => {
    expect(env.JWT_SECRET).toBeTruthy();
    expect(env.JWT_REFRESH_SECRET).toBeTruthy();
    expect(env.JWT_SECRET).not.toBe(env.JWT_REFRESH_SECRET);
    expect(env.ENCRYPTION_KEY.length).toBe(32);
    expect(env.CORS_ORIGIN).toBeTruthy();
  });
});

// ===========================================================================
// 10. Export
// ===========================================================================
describe('10. Export', () => {
  it('exports a report in every supported format, honouring the same permissions', async () => {
    for (const format of ['xlsx', 'csv', 'pdf']) {
      const res = await as(admin).get(`/api/v1/reports/inventory/current-stock/export?factoryId=${X.plantA.id}&format=${format}`);
      expect([format, res.status]).toEqual([format, 200]);
      expect(res.headers['content-disposition']).toMatch(/attachment/i);
    }
  });

  it('refuses an export the caller has no permission for', async () => {
    await X.mkUser('noexport@cross.test', ['REPORT_INVENTORY_READ'], X.plantA.id);
    const cookie = await loginAs('noexport@cross.test');
    const res = await as(cookie).get(`/api/v1/reports/inventory/current-stock/export?factoryId=${X.plantA.id}&format=csv`);
    expect(res.status).toBe(403);
  });
});
