const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, UserFactory, AdGroup, AdGroupMember, Notification,
} = require('../src/models/index');
const { NotificationRead } = require('../src/api/notifications/notificationRead.model');
const { WebPermissions } = require('../src/utils/constants');

/**
 * C19: a broadcast notification is one row shared by its whole audience, so
 * reading it used to set its single `readAt` — clearing it for every user in
 * the tenant. Broadcasts now carry a read receipt per user; personal alerts
 * keep their own readAt.
 */

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const login = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

// A tenant with one factory and the given employees, each holding INVENTORY_READ
// (DEAD_STOCK broadcasts are gated on it) and assigned to the factory.
const seedTenant = async (slug, emails) => {
  const tenant = await Tenant.create({ name: `Tenant ${slug}`, slug, status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: `Org ${slug}`, code: `ORG-${slug}`.slice(0, 20) });
  const factory = await Factory.create({ tenantId, organizationId: org.id, name: `Factory ${slug}`, code: `FAC-${slug}`.slice(0, 20) });
  const group = await AdGroup.create({ tenantId, name: `Inventory ${slug}`, permissions: [WebPermissions.INVENTORY_READ] });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const users = [];
  for (const email of emails) {
    const user = await User.create(
      { tenantId, email, passwordHash, firstName: 'Read', lastName: 'Receipt', role: 'EMPLOYEE' },
      { validate: false }
    );
    await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });
    await UserFactory.create({ tenantId, userId: user.id, factoryId: factory.id });
    users.push(user);
  }
  return { tenantId, factory, users };
};

const broadcast = (tenantId, factoryId, dedupeKey) =>
  Notification.create({
    tenantId, type: 'DEAD_STOCK', severity: 'HIGH', title: `Broadcast ${dedupeKey}`,
    message: 'Lot idle', factoryId, userId: null, dedupeKey,
  });

const unreadCount = async (cookie) => {
  const res = await request(app).get('/api/v1/notifications/unread-count').set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.data.unread;
};

const listRows = async (cookie, query = '') => {
  const res = await request(app).get(`/api/v1/notifications?page=1&limit=50${query}`).set('Cookie', cookie);
  expect(res.status).toBe(200);
  return res.body.data.rows;
};

let tenantId;
let factory;
let userA;
let cookieA;
let cookieB;
let otherTenant;
let cookieC;

beforeAll(async () => {
  await resetDatabase();

  const seeded = await seedTenant('nr-main', ['a@read-receipts.test', 'b@read-receipts.test']);
  ({ tenantId, factory } = seeded);
  [userA] = seeded.users;

  otherTenant = await seedTenant('nr-other', ['c@read-receipts.test']);

  cookieA = await login('a@read-receipts.test');
  cookieB = await login('b@read-receipts.test');
  cookieC = await login('c@read-receipts.test');
});

afterAll(async () => {
  await sequelize.close();
});

describe('C19 broadcast read receipts', () => {
  let n1;

  beforeAll(async () => {
    n1 = await broadcast(tenantId, factory.id, 'DEAD_STOCK:nr-1');
  });

  it('shows a broadcast as unread to everyone in its audience', async () => {
    expect(await unreadCount(cookieA)).toBe(1);
    expect(await unreadCount(cookieB)).toBe(1);
    const rowsB = await listRows(cookieB);
    expect(rowsB.find((r) => r.id === n1.id).readAt).toBeNull();
  });

  it('marking it read clears it for the reader only', async () => {
    const res = await request(app).put(`/api/v1/notifications/${n1.id}/read`).set('Cookie', cookieA);
    expect(res.status).toBe(200);
    // Response shape unchanged: the row, with the caller's own readAt.
    expect(res.body.data.id).toBe(n1.id);
    expect(res.body.data.readAt).not.toBeNull();
    expect(res.body.data.myRead).toBeUndefined();

    expect(await unreadCount(cookieA)).toBe(0);
    expect(await unreadCount(cookieB)).toBe(1);

    const rowsA = await listRows(cookieA);
    expect(rowsA.find((r) => r.id === n1.id).readAt).not.toBeNull();
    const rowsB = await listRows(cookieB);
    expect(rowsB.find((r) => r.id === n1.id).readAt).toBeNull();

    const unreadOnlyA = await listRows(cookieA, '&unreadOnly=true');
    expect(unreadOnlyA.map((r) => r.id)).not.toContain(n1.id);
    const unreadOnlyB = await listRows(cookieB, '&unreadOnly=true');
    expect(unreadOnlyB.map((r) => r.id)).toContain(n1.id);

    // The shared row itself is never written any more.
    const row = await Notification.findByPk(n1.id);
    expect(row.readAt).toBeNull();
    expect(await NotificationRead.count({ where: { notificationId: n1.id } })).toBe(1);
  });

  it('marking it read twice is idempotent', async () => {
    const res = await request(app).put(`/api/v1/notifications/${n1.id}/read`).set('Cookie', cookieA);
    expect(res.status).toBe(200);
    expect(await NotificationRead.count({ where: { notificationId: n1.id } })).toBe(1);
  });

  it('read-all by one user leaves the others unaffected', async () => {
    const n2 = await broadcast(tenantId, factory.id, 'DEAD_STOCK:nr-2');
    const n3 = await broadcast(tenantId, null, 'DEAD_STOCK:nr-3'); // tenant-wide

    expect(await unreadCount(cookieA)).toBe(2);
    expect(await unreadCount(cookieB)).toBe(3);

    const res = await request(app).put('/api/v1/notifications/read-all').set('Cookie', cookieA);
    expect(res.status).toBe(200);
    expect(res.body.data.markedRead).toBe(2);

    expect(await unreadCount(cookieA)).toBe(0);
    expect(await unreadCount(cookieB)).toBe(3);

    for (const n of [n2, n3]) {
      const row = await Notification.findByPk(n.id);
      expect(row.readAt).toBeNull();
    }

    // B can still clear their own copy afterwards.
    const resB = await request(app).put('/api/v1/notifications/read-all').set('Cookie', cookieB);
    expect(resB.body.data.markedRead).toBe(3);
    expect(await unreadCount(cookieB)).toBe(0);
  });

  it('a personal notification still uses its own readAt', async () => {
    const mine = await Notification.create({
      tenantId, type: 'CREDIT_LIMIT_BREACH', severity: 'HIGH', title: 'Personal',
      message: 'for A', userId: userA.id, dedupeKey: 'CREDIT_LIMIT_BREACH:nr-personal',
    });
    expect(await unreadCount(cookieA)).toBe(1);
    expect(await unreadCount(cookieB)).toBe(0); // not in B's audience

    const res = await request(app).put(`/api/v1/notifications/${mine.id}/read`).set('Cookie', cookieA);
    expect(res.status).toBe(200);
    expect(res.body.data.readAt).not.toBeNull();

    const row = await Notification.findByPk(mine.id);
    expect(row.readAt).not.toBeNull();
    expect(await NotificationRead.count({ where: { notificationId: mine.id } })).toBe(0);
    expect(await unreadCount(cookieA)).toBe(0);

    // B cannot read A's personal alert at all.
    const other = await request(app).put(`/api/v1/notifications/${mine.id}/read`).set('Cookie', cookieB);
    expect(other.status).toBe(404);
  });

  it('read-all marks personal alerts read via readAt and broadcasts via receipts', async () => {
    const personal = await Notification.create({
      tenantId, type: 'CREDIT_LIMIT_BREACH', severity: 'HIGH', title: 'Personal 2',
      message: 'for A', userId: userA.id, dedupeKey: 'CREDIT_LIMIT_BREACH:nr-personal-2',
    });
    const n4 = await broadcast(tenantId, factory.id, 'DEAD_STOCK:nr-4');

    const res = await request(app).put('/api/v1/notifications/read-all').set('Cookie', cookieA);
    expect(res.body.data.markedRead).toBe(2);

    expect((await Notification.findByPk(personal.id)).readAt).not.toBeNull();
    expect((await Notification.findByPk(n4.id)).readAt).toBeNull();
    expect(await unreadCount(cookieB)).toBe(1);
  });

  it('keeps receipts tenant-isolated', async () => {
    const theirs = await broadcast(otherTenant.tenantId, otherTenant.factory.id, 'DEAD_STOCK:nr-other');
    expect(await unreadCount(cookieC)).toBe(1);

    // Nothing the main tenant did reads the other tenant's alerts.
    await request(app).put('/api/v1/notifications/read-all').set('Cookie', cookieA);
    expect(await unreadCount(cookieC)).toBe(1);

    // And another tenant's broadcast cannot be marked read across the boundary.
    const cross = await request(app).put(`/api/v1/notifications/${theirs.id}/read`).set('Cookie', cookieA);
    expect(cross.status).toBe(404);
    expect(await NotificationRead.count({ where: { notificationId: theirs.id } })).toBe(0);

    // C's own read produces a receipt in C's tenant, and touches nothing in A's.
    const receiptsBefore = await NotificationRead.count({ where: { tenantId } });
    const res = await request(app).put(`/api/v1/notifications/${theirs.id}/read`).set('Cookie', cookieC);
    expect(res.status).toBe(200);
    expect(await unreadCount(cookieC)).toBe(0);
    const receipt = await NotificationRead.unscoped().findOne({ where: { notificationId: theirs.id } });
    expect(receipt.tenantId).toBe(otherTenant.tenantId);
    expect(await NotificationRead.count({ where: { tenantId } })).toBe(receiptsBefore);
  });
});
