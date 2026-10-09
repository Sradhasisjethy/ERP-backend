/**
 * Regression tests for the authentication / authorization review of
 * 2026-10-09 (findings C1, C2, C3, C5, C16, C21 and S1). Each request here
 * succeeded, or each guard here was missing, before the fix.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { StockLedgerService } = require('../src/api/inventory/stockLedger.service');
const { EmployeeDocument } = require('../src/api/users/employeeDocument.model');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, StockLot,
  AdGroup, AdGroupMember, UserFactory,
} = require('../src/models/index');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const login = (email) => request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
const loginAs = async (email) => extractCookie(await login(email), 'accessToken');

let T;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const tenant = await Tenant.create({ name: 'Review Co', slug: 'review-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Review Pvt Ltd', code: 'RC' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'ACTIVE' });
  const factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant', code: 'PL', state: 'Odisha' });

  const mk = (email, role = 'EMPLOYEE') =>
    User.create({ tenantId, email, passwordHash, firstName: 'F', lastName: 'L', role, status: 'ACTIVE' }, { validate: false });
  const grant = async (user, name, permissions, status = 'active') => {
    const group = await AdGroup.create({ tenantId, name, permissions, status });
    await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });
    return group;
  };

  await mk('admin@review.test', 'PLATFORM_ADMIN');
  const hr = await mk('hr@review.test');
  await grant(hr, 'HR', ['EMPLOYEE_READ', 'EMPLOYEE_MODIFY']);
  const boss = await mk('boss@review.test');
  const starRole = await grant(boss, 'Administrators', ['*']);
  const staff = await mk('staff@review.test');
  const roleAdmin = await mk('roles@review.test');
  await grant(roleAdmin, 'Role admins', ['ROLE_READ', 'ROLE_MODIFY', 'ROLE_DELETE']);
  const dormant = await grant(roleAdmin, 'Dormant approvers', ['PURCHASE_APPROVE'], 'inactive');
  const reader = await mk('reader@review.test');
  const readerRole = await grant(reader, 'Party readers', ['PARTY_READ']);
  const clerk = await mk('clerk@review.test');
  await grant(clerk, 'Counter', ['INVOICE_CREATE', 'INVOICE_READ']);
  await UserFactory.create({ tenantId, userId: clerk.id, factoryId: factory.id });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  const pipe = await Product.create({ tenantId, uomId: uom.id, name: 'Pipe', code: 'FG-P', productType: 'FINISHED_GOOD' });
  const slab = await Product.create({ tenantId, uomId: uom.id, name: 'Slab', code: 'FG-S', productType: 'FINISHED_GOOD' });
  const today = new Date().toISOString().slice(0, 10);
  const lot = (productId, status, tag) => StockLot.create({
    tenantId, factoryId: factory.id, productId, lotNumber: `LOT-${tag}`, originType: 'PRODUCTION', originId: factory.id,
    originDate: today, curingDays: 7, status, qtyOriginal: 10, qtyAvailable: 10,
  });
  const curingPipe = await lot(pipe.id, 'CURING', 'CP');
  const availablePipe = await lot(pipe.id, 'AVAILABLE', 'AP');
  const availableSlab = await lot(slab.id, 'AVAILABLE', 'AS');

  const rival = await Tenant.create({ name: 'Rival', slug: 'review-rival', status: 'active' });
  const rivalUser = await User.create(
    { tenantId: rival.id, email: 'user@review-rival.test', passwordHash, firstName: 'R', lastName: 'R', role: 'EMPLOYEE', status: 'ACTIVE' },
    { validate: false }
  );

  T = {
    tenantId, factory, hr, boss, starRole, staff, roleAdmin, dormant, reader, readerRole, clerk,
    pipe, curingPipe, availablePipe, availableSlab, rivalUser,
  };
  T.admin = await loginAs('admin@review.test');
  T.hrCookie = await loginAs('hr@review.test');
  T.roleCookie = await loginAs('roles@review.test');
  T.clerkCookie = await loginAs('clerk@review.test');
});

afterAll(async () => {
  await sequelize.close();
});

describe('C1: a user editor cannot act on an account that out-ranks it', () => {
  it('refuses changing the email of a user whose power comes from a * role group', async () => {
    const res = await request(app).put(`/api/v1/users/${T.boss.id}`).set('Cookie', T.hrCookie).send({ email: 'x@evil.test' });
    expect(res.status).toBe(403);
    expect((await User.findByPk(T.boss.id)).email).toBe('boss@review.test');
  });

  it('refuses stripping that user\'s roles with roleId: null', async () => {
    const res = await request(app).put(`/api/v1/users/${T.boss.id}`).set('Cookie', T.hrCookie).send({ roleId: null });
    expect(res.status).toBe(403);
    expect(await AdGroupMember.count({ where: { employeeId: T.boss.id } })).toBe(1);
  });

  it('still lets HR edit ordinary staff', async () => {
    const res = await request(app).put(`/api/v1/users/${T.staff.id}`).set('Cookie', T.hrCookie).send({ phone: '12345' });
    expect(res.status).toBe(200);
  });
});

describe('C3: role status changes are checked and retire tokens', () => {
  it('refuses reactivating a dormant role the actor could not grant', async () => {
    const res = await request(app).put(`/api/v1/roles/${T.dormant.id}`).set('Cookie', T.roleCookie).send({ status: 'active' });
    expect(res.status).toBe(403);
    expect((await AdGroup.findByPk(T.dormant.id)).status).toBe('inactive');
  });

  it('refuses a limited actor deactivating or emptying a role that out-ranks it', async () => {
    const off = await request(app).put(`/api/v1/roles/${T.starRole.id}`).set('Cookie', T.roleCookie).send({ status: 'inactive' });
    expect(off.status).toBe(403);
    const empty = await request(app).put(`/api/v1/roles/${T.starRole.id}`).set('Cookie', T.roleCookie).send({ permissions: [] });
    expect(empty.status).toBe(403);
    const role = await AdGroup.findByPk(T.starRole.id);
    expect(role.status).toBe('active');
    expect(role.permissions).toContain('*');
  });

  it('refuses deactivating the last full-access role, even for a full-access actor', async () => {
    const res = await request(app).put(`/api/v1/roles/${T.starRole.id}`).set('Cookie', T.admin).send({ status: 'inactive' });
    expect(res.status).toBe(403);
  });

  it('ends members\' sessions when their role is deactivated', async () => {
    const before = await loginAs('reader@review.test');
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', before)).status).toBe(200);
    const res = await request(app).put(`/api/v1/roles/${T.readerRole.id}`).set('Cookie', T.admin).send({ status: 'inactive' });
    expect(res.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', before)).status).toBe(401);
  });
});

describe('C5: removing a role member is checked', () => {
  it('refuses a limited actor removing someone from a role that out-ranks it', async () => {
    const res = await request(app).delete(`/api/v1/roles/${T.starRole.id}/members/${T.boss.id}`).set('Cookie', T.roleCookie);
    expect(res.status).toBe(403);
    expect(await AdGroupMember.count({ where: { adGroupId: T.starRole.id, employeeId: T.boss.id } })).toBe(1);
  });

  it('refuses removing the last full-access member', async () => {
    const res = await request(app).delete(`/api/v1/roles/${T.starRole.id}/members/${T.boss.id}`).set('Cookie', T.admin);
    expect(res.status).toBe(403);
  });
});

describe('C2: choosing a specific lot is a named grant, and the lot must fit', () => {
  it('refuses overrideLotId on a counter sale without OVERRIDE_LOT_SELECTION', async () => {
    const res = await request(app).post('/api/v1/retail/counter-sales').set('Cookie', T.clerkCookie).send({
      factoryId: T.factory.id,
      invoiceDate: new Date().toISOString().slice(0, 10),
      customer: { name: 'Walk-in' },
      lines: [{ productId: T.pipe.id, quantity: 1, ratePaise: 100, overrideLotId: T.availablePipe.id, overrideLotReason: 'test' }],
    });
    expect(res.status).toBe(403);
    expect(Number((await StockLot.findByPk(T.availablePipe.id)).qtyAvailable)).toBe(10);
  });

  const consume = (overrideLotId) =>
    sequelize.transaction((transaction) =>
      StockLedgerService.consumeFifo({
        factoryId: T.factory.id, productId: T.pipe.id, quantity: 1, movementType: 'SALE_OUT',
        referenceType: 'Test', referenceId: crypto.randomUUID(), overrideLotId, overrideReason: 'test', transaction,
      })
    );

  it('refuses drawing on a lot that is still curing', async () => {
    await expect(consume(T.curingPipe.id)).rejects.toThrow(/CURING/);
    expect(Number((await StockLot.findByPk(T.curingPipe.id)).qtyAvailable)).toBe(10);
  });

  it('refuses drawing on a lot of a different product', async () => {
    await expect(consume(T.availableSlab.id)).rejects.toThrow(/different product/);
    expect(Number((await StockLot.findByPk(T.availableSlab.id)).qtyAvailable)).toBe(10);
  });
});

describe('C16: the login response carries no credential state', () => {
  it('omits the reset token hash and expiry', async () => {
    const res = await login('hr@review.test');
    expect(res.status).toBe(200);
    expect(res.body.data.user).not.toHaveProperty('resetPasswordToken');
    expect(res.body.data.user).not.toHaveProperty('resetPasswordExpires');
    expect(res.body.data.user).not.toHaveProperty('passwordHash');
  });
});

describe('C21: no path is exempt from the status check', () => {
  it('refuses a terminated user\'s token on a path ending in /refresh', async () => {
    const gone = await User.create(
      { tenantId: T.tenantId, email: 'gone@review.test', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'G', lastName: 'G', role: 'EMPLOYEE', status: 'ACTIVE' },
      { validate: false }
    );
    const cookie = await loginAs('gone@review.test');
    await gone.update({ status: 'TERMINATED' });
    expect((await request(app).get('/api/v1/users/refresh').set('Cookie', cookie)).status).toBe(401);
  });
});

describe('S1: employee document upload keeps the tenant context', () => {
  const pdf = Buffer.from('%PDF-1.4\n%synthetic test document\n');

  it('stores an own document under the caller\'s tenant', async () => {
    const cookie = await loginAs('staff@review.test');
    const res = await request(app)
      .post(`/api/v1/users/${T.staff.id}/documents`)
      .set('Cookie', cookie)
      .field('documentType', 'ID')
      .attach('document', pdf, { filename: 'id.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(201);

    const row = await EmployeeDocument.unscoped().findByPk(res.body.data.id);
    expect(row.tenantId).toBe(T.tenantId);
    fs.rmSync(path.join(__dirname, '../uploads/employees', T.staff.id), { recursive: true, force: true });
  });

  it('refuses attaching a document to another tenant\'s employee', async () => {
    const res = await request(app)
      .post(`/api/v1/users/${T.rivalUser.id}/documents`)
      .set('Cookie', T.admin)
      .field('documentType', 'ID')
      .attach('document', pdf, { filename: 'id.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(404);
    expect(await EmployeeDocument.unscoped().count({ where: { employeeId: T.rivalUser.id } })).toBe(0);
    fs.rmSync(path.join(__dirname, '../uploads/employees', T.rivalUser.id), { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Third pass: the remaining review findings.
// ---------------------------------------------------------------------------
const mkUser = async (email, permissions = []) => {
  const user = await User.create(
    { tenantId: T.tenantId, email, passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'N', lastName: 'N', role: 'EMPLOYEE', status: 'ACTIVE' },
    { validate: false }
  );
  if (permissions.length) {
    const group = await AdGroup.create({ tenantId: T.tenantId, name: `G ${email}`, permissions });
    await AdGroupMember.create({ tenantId: T.tenantId, adGroupId: group.id, employeeId: user.id });
  }
  return user;
};

describe('C4: a colleague\'s documents need an HR-level grant', () => {
  it('refuses EMPLOYEE_READ alone, and still serves your own', async () => {
    const viewer = await mkUser('viewer@review.test', ['EMPLOYEE_READ']);
    const cookie = await loginAs('viewer@review.test');
    expect((await request(app).get(`/api/v1/users/${T.staff.id}/documents`).set('Cookie', cookie)).status).toBe(403);
    expect((await request(app).get(`/api/v1/users/${viewer.id}/documents`).set('Cookie', cookie)).status).toBe(200);
  });
});

describe('C6: a refresh token can be spent once, even by two racing requests', () => {
  it('lets exactly one of two concurrent refreshes through', async () => {
    await mkUser('racer@review.test');
    const { refreshToken } = (await login('racer@review.test')).body.data;
    const results = await Promise.all([
      request(app).post('/api/v1/auth/refresh').send({ refreshToken }),
      request(app).post('/api/v1/auth/refresh').send({ refreshToken }),
    ]);
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });
});

describe('C7: a suspended company signs nobody in', () => {
  it('refuses login and existing tokens once the tenant is suspended', async () => {
    const t = await Tenant.create({ name: 'Paused', slug: 'review-paused', status: 'active' });
    await User.create(
      { tenantId: t.id, email: 'user@paused.test', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'P', lastName: 'P', role: 'EMPLOYEE', status: 'ACTIVE' },
      { validate: false }
    );
    const cookie = await loginAs('user@paused.test');
    await t.update({ status: 'suspended' });
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect((await login('user@paused.test')).status).toBe(401);
  });
});

describe('C14: signing out ends sessions now', () => {
  it('logout retires the access token it was holding', async () => {
    await mkUser('leaver@review.test');
    const res = await login('leaver@review.test');
    const cookie = extractCookie(res, 'accessToken');
    await request(app).post('/api/v1/auth/logout').send({ refreshToken: res.body.data.refreshToken });
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
  });

  it('logout-all ends the other devices too', async () => {
    await mkUser('two-devices@review.test');
    const phone = await login('two-devices@review.test');
    const laptop = await login('two-devices@review.test');
    const out = await request(app).post('/api/v1/auth/logout-all').set('Cookie', extractCookie(laptop, 'accessToken'));
    expect(out.status).toBe(200);
    expect((await request(app).post('/api/v1/auth/refresh').send({ refreshToken: phone.body.data.refreshToken })).status).toBe(401);
  });

  it('change-password needs the current password and ends every session', async () => {
    await mkUser('changer@review.test');
    const cookie = await loginAs('changer@review.test');
    const wrong = await request(app).post('/api/v1/auth/change-password').set('Cookie', cookie)
      .send({ currentPassword: 'not-it', newPassword: 'a-new-password' });
    expect(wrong.status).toBe(400);
    const right = await request(app).post('/api/v1/auth/change-password').set('Cookie', cookie)
      .send({ currentPassword: PASSWORD, newPassword: 'a-new-password' });
    expect(right.status).toBe(200);
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', cookie)).status).toBe(401);
    expect((await request(app).post('/api/v1/auth/login').send({ email: 'changer@review.test', password: 'a-new-password' })).status).toBe(200);
  });
});

describe('C17: POST /settings creates, it does not overwrite', () => {
  it('refuses an existing key and creates a new one', async () => {
    const created = await request(app).post('/api/v1/settings').set('Cookie', T.admin).send({ key: 'review.flag', value: 1 });
    expect(created.status).toBe(201);
    const again = await request(app).post('/api/v1/settings').set('Cookie', T.admin).send({ key: 'review.flag', value: 2 });
    expect(again.status).toBe(409);
    const read = await request(app).get('/api/v1/settings/review.flag').set('Cookie', T.admin);
    expect(read.body.data.value).toBe(1);
  });
});

describe('C22: import history shows only masters the caller may import', () => {
  it('returns no runs to a user with no import grant', async () => {
    await mkUser('nogrant@review.test', ['PARTY_READ']);
    const res = await request(app).get('/api/v1/master-data/imports').set('Cookie', await loginAs('nogrant@review.test'));
    expect(res.status).toBe(200);
    expect(res.body.data.rows || res.body.data).toHaveLength(0);
  });
});

describe('C8 (users): a user can only point at people and places in its own tenant', () => {
  it('refuses another tenant\'s employee as manager', async () => {
    const res = await request(app).put(`/api/v1/users/${T.staff.id}`).set('Cookie', T.admin).send({ managerId: T.rivalUser.id });
    expect(res.status).toBe(404);
    expect((await User.findByPk(T.staff.id)).managerId).toBeNull();
  });
});
