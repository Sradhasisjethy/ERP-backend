const request = require('supertest');
const { randomUUID } = require('crypto');
const bcrypt = require('bcrypt');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, Factory, FinancialYear } = require('../src/models/index');
const { RefreshToken } = require('../src/api/auth/refreshToken.model');
const { IdempotencyKey } = require('../src/api/idempotency/idempotencyKey.model');
const { pruneExpiredRows, withNightlyLock } = require('../src/jobs/nightly');
const { clearDashboardCache } = require('../src/api/dashboard/dashboard.controller');
const { bumpUser } = require('../src/utils/permissionVersion');
const { sessionStateCache } = require('../src/core/sessionStateCache');

/**
 * The scalability audit's cheap fixes, each pinned so it cannot quietly
 * regress: the dashboard is remembered rather than rebuilt per poll, only one
 * instance runs the nightly batch, tables that only ever grew are pruned, and
 * a mistyped report id is the client's fault, not a server error.
 */

const PASSWORD = 'password123';
let tenantId;
let api;

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Hardening Co', slug: 'hardening-co', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Hardening Co Pvt Ltd', code: 'HRD' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  await Factory.create({ tenantId, organizationId: org.id, name: 'Plant', code: 'HRD', state: 'Odisha' });
  await User.create(
    { tenantId, email: 'admin@hardening.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Asha', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'admin@hardening.co', password: PASSWORD });
  const cookie = login.headers['set-cookie'].find((c) => c.startsWith('accessToken=')).split(';')[0];
  api = {
    get: (url, query) => request(app).get(url).set('Cookie', cookie).query(query || {}),
  };
});

afterAll(async () => {
  await sequelize.close();
});

describe('Login on native bcrypt', () => {
  it('still accepts a password hashed by the library it replaced', async () => {
    // The fixture above is a bcrypt hash; real accounts were hashed by bcryptjs.
    const bcryptjs = require('bcryptjs');
    await User.create(
      { tenantId, email: 'legacy@hardening.co', passwordHash: await bcryptjs.hash(PASSWORD, 10), firstName: 'L', lastName: 'G', role: 'EMPLOYEE' },
      { validate: false }
    );
    const res = await request(app).post('/api/v1/auth/login').send({ email: 'legacy@hardening.co', password: PASSWORD });
    expect(res.status).toBe(200);
  });
});

describe('The dashboard is remembered between polls', () => {
  beforeEach(() => clearDashboardCache());

  it('builds once and serves the same answer to the next poll', async () => {
    const first = await api.get('/api/v1/dashboard/stats');
    expect(first.status).toBe(200);
    expect(first.headers['x-cache']).toBe('MISS');

    const second = await api.get('/api/v1/dashboard/stats');
    expect(second.headers['x-cache']).toBe('HIT');
    expect(second.body.data).toEqual(first.body.data);
  });

  it('keeps a plant filter as its own entry', async () => {
    await api.get('/api/v1/dashboard/stats');
    const factory = await Factory.findOne({ where: { code: 'HRD' } });
    const filtered = await api.get('/api/v1/dashboard/stats', { factoryId: factory.id });
    // A different scope is a different answer, so it must not hit the first one.
    expect(filtered.headers['x-cache']).toBe('MISS');
  });
});

describe('Only one instance runs the nightly batch', () => {
  it('lets the second runner through only after the first has finished', async () => {
    let releaseFirst;
    const firstFinished = new Promise((resolve) => { releaseFirst = resolve; });

    const first = withNightlyLock(async () => { await firstFinished; return { ran: 'first' }; });
    // Give the first runner a moment to actually take the lock.
    await new Promise((resolve) => setTimeout(resolve, 200));
    const second = await withNightlyLock(async () => ({ ran: 'second' }));
    expect(second).toEqual({ skipped: 'another instance is running the nightly jobs' });

    releaseFirst();
    expect(await first).toEqual({ ran: 'first' });

    // And once released, a runner gets in again.
    expect(await withNightlyLock(async () => ({ ran: 'third' }))).toEqual({ ran: 'third' });
  });
});

describe('Tables that only ever grew are pruned', () => {
  it('drops expired refresh tokens and day-old idempotency keys, and nothing else', async () => {
    const user = await User.findOne({ where: { email: 'admin@hardening.co' } });
    const past = new Date(Date.now() - 3600 * 1000);
    const future = new Date(Date.now() + 7 * 86400 * 1000);
    const expiredJti = randomUUID();
    const liveJti = randomUUID();
    await RefreshToken.bulkCreate([
      { tenantId, userId: user.id, jti: expiredJti, expiresAt: past },
      { tenantId, userId: user.id, jti: liveJti, expiresAt: future },
    ], { validate: false });
    const twoDaysAgo = new Date(Date.now() - 2 * 86400 * 1000);
    const stale = await IdempotencyKey.create({ tenantId, key: 'stale', endpoint: 'POST /x', requestHash: 'h', status: 'COMPLETED' });
    await IdempotencyKey.update({ createdAt: twoDaysAgo }, { where: { id: stale.id }, silent: true });
    await IdempotencyKey.create({ tenantId, key: 'fresh', endpoint: 'POST /x', requestHash: 'h', status: 'COMPLETED' });

    const result = await pruneExpiredRows();

    expect(result.expiredRefreshTokens).toBeGreaterThanOrEqual(1);
    expect(result.staleIdempotencyKeys).toBeGreaterThanOrEqual(1);
    expect(await RefreshToken.count({ where: { jti: expiredJti } })).toBe(0);
    expect(await RefreshToken.count({ where: { jti: liveJti } })).toBe(1);
    expect(await IdempotencyKey.count({ where: { key: 'stale' } })).toBe(0);
    expect(await IdempotencyKey.count({ where: { key: 'fresh' } })).toBe(1);
  });
});

/**
 * Several routers share the /api/v1 prefix and each runs `authenticate`, so a
 * request used to repeat the same user lookup once per router it passed —
 * four times for a list screen. It now runs once; these pin both halves: the
 * saving, and that the check it saves still refuses what it must.
 */
describe('The session check runs once per request, and still bites', () => {
  const loginAs = async (email) => {
    const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
    return res.headers['set-cookie'].find((c) => c.startsWith('accessToken=')).split(';')[0];
  };

  const countLookups = async (run) => {
    let lookups = 0;
    const previous = sequelize.options.logging;
    sequelize.options.logging = (sql) => { if (/"permissionsVersion"/.test(sql) && /FROM "employees"/.test(sql)) lookups += 1; };
    try {
      await run();
    } finally {
      sequelize.options.logging = previous;
    }
    return lookups;
  };

  it('looks the user up at most once, however many routers the request passes', async () => {
    sessionStateCache.clear();
    const lookups = await countLookups(async () => {
      expect((await api.get('/api/v1/parties', { page: 1, limit: 10 })).status).toBe(200);
    });
    expect(lookups).toBe(1);
  });

  it('answers the next requests from memory while nothing about the user has changed', async () => {
    await api.get('/api/v1/parties');
    const lookups = await countLookups(async () => {
      for (const url of ['/api/v1/parties', '/api/v1/products', '/api/v1/factories']) {
        expect((await api.get(url)).status).toBe(200);
      }
    });
    expect(lookups).toBe(0);
  });

  it('refuses a token minted before the user\'s access changed, even straight after using it', async () => {
    await User.create(
      { tenantId, email: 'moved@hardening.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'M', lastName: 'V', role: 'PLATFORM_ADMIN' },
      { validate: false }
    );
    const cookie = await loginAs('moved@hardening.co');
    expect((await request(app).get('/api/v1/parties').set('Cookie', cookie)).status).toBe(200);

    // The path every role and membership edit takes. It must win over the
    // answer remembered from the request just above.
    const moved = await User.findOne({ where: { email: 'moved@hardening.co' } });
    await bumpUser(moved.id);

    const res = await request(app).get('/api/v1/parties').set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/access has changed/);
  });

  it('refuses a disabled account at once', async () => {
    await User.create(
      { tenantId, email: 'leaver@hardening.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'L', lastName: 'V', role: 'PLATFORM_ADMIN' },
      { validate: false }
    );
    const cookie = await loginAs('leaver@hardening.co');
    expect((await request(app).get('/api/v1/parties').set('Cookie', cookie)).status).toBe(200);

    // As the Employees screen does it: an update to the loaded row.
    const leaver = await User.findOne({ where: { email: 'leaver@hardening.co' } });
    await leaver.update({ status: 'INACTIVE' });

    const res = await request(app).get('/api/v1/parties').set('Cookie', cookie);
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/no longer active/);
  });

  it('refuses a disabled account at once when disabled in bulk', async () => {
    await User.create(
      { tenantId, email: 'bulk@hardening.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'B', lastName: 'K', role: 'PLATFORM_ADMIN' },
      { validate: false }
    );
    const cookie = await loginAs('bulk@hardening.co');
    expect((await request(app).get('/api/v1/parties').set('Cookie', cookie)).status).toBe(200);

    await User.update({ status: 'TERMINATED' }, { where: { email: 'bulk@hardening.co' } });

    expect((await request(app).get('/api/v1/parties').set('Cookie', cookie)).status).toBe(401);
  });

  it('drops the remembered answer when a transaction that changed access commits', async () => {
    await User.create(
      { tenantId, email: 'txn@hardening.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'T', lastName: 'X', role: 'PLATFORM_ADMIN' },
      { validate: false }
    );
    const cookie = await loginAs('txn@hardening.co');
    const user = await User.findOne({ where: { email: 'txn@hardening.co' } });

    await sequelize.transaction(async (transaction) => {
      await bumpUser(user.id, transaction);
      // Mid-transaction, a request on another connection still reads the
      // committed (old) row and remembers it. A request made from inside this
      // callback would join the transaction through CLS and see the new row,
      // so that other request's stale answer is planted directly.
      sessionStateCache.set(user.id, { permissionsVersion: user.permissionsVersion, status: user.status });
    });

    // The commit must have evicted what was remembered in between.

    expect((await request(app).get('/api/v1/parties').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('A mistyped report id', () => {
  it('is refused as a bad request, not reported as a server error', async () => {
    const res = await api.get('/api/v1/reports/sales-summary');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/UUID/);
  });
});
