/**
 * Regression tests for the 2026-10-09 security assessment (brain/security/).
 * Each block names the finding it pins down; every one of these requests
 * succeeded before the fix.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const emailService = require('../src/services/email.service');
const {
  Tenant, User, Organization, FinancialYear, AdGroup, AdGroupMember,
} = require('../src/models/index');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const login = (email, password = PASSWORD) => request(app).post('/api/v1/auth/login').send({ email, password });
const loginAs = async (email) => extractCookie(await login(email), 'accessToken');

// Smallest valid PNG: signature plus IHDR/IDAT/IEND for a 1x1 pixel.
const PNG_1PX = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082',
  'hex'
);

let T;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const tenant = await Tenant.create({ name: 'Sec Co', slug: 'sec-co', status: 'active' });
  const tenantId = tenant.id;
  await Organization.create({ tenantId, name: 'Sec Pvt Ltd', code: 'SC' });
  const mk = (email, role = 'EMPLOYEE', extra = {}) =>
    User.create({ tenantId, email, passwordHash, firstName: 'F', lastName: 'L', role, status: 'ACTIVE', ...extra }, { validate: false });

  const owner = await mk('owner@sec.test', 'TENANT_OWNER');
  const hr = await mk('hr@sec.test');
  const hrRole = await AdGroup.create({ tenantId, name: 'HR', permissions: ['EMPLOYEE_READ', 'EMPLOYEE_MODIFY'] });
  await AdGroupMember.create({ tenantId, adGroupId: hrRole.id, employeeId: hr.id });
  const staff = await mk('staff@sec.test');
  await mk('admin@sec.test', 'PLATFORM_ADMIN');

  const fyCurrent = await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'ACTIVE' });
  const fyNext = await FinancialYear.create({ tenantId, code: '2027-28', startDate: '2027-04-01', endDate: '2028-03-31', isCurrent: false, status: 'PLANNED' });

  const rival = await Tenant.create({ name: 'Rival', slug: 'sec-rival', status: 'active' });
  await Organization.create({ tenantId: rival.id, name: 'Rival Pvt', code: 'RV' });
  const rivalUser = await User.create(
    { tenantId: rival.id, email: 'user@rival.test', passwordHash, firstName: 'R', lastName: 'R', role: 'EMPLOYEE', status: 'ACTIVE' },
    { validate: false }
  );
  const rivalFy = await FinancialYear.create({ tenantId: rival.id, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'ACTIVE' });

  T = { tenantId, owner, hr, staff, fyCurrent, fyNext, rival, rivalUser, rivalFy };
  T.admin = await loginAs('admin@sec.test');
  T.hrCookie = await loginAs('hr@sec.test');
});

afterEach(() => jest.restoreAllMocks());

afterAll(async () => {
  await sequelize.close();
});

describe('F-01 / F-09: a user write takes only the fields the schema declares', () => {
  it('ignores passwordHash, isSystem and permissionsVersion in PUT /users/:id', async () => {
    const attackerHash = await bcrypt.hash('taken-over-1', 10);
    const res = await request(app)
      .put(`/api/v1/users/${T.staff.id}`)
      .set('Cookie', T.hrCookie)
      .send({ firstName: 'Renamed', passwordHash: attackerHash, isSystem: true, permissionsVersion: 999 });
    expect(res.status).toBe(200);

    const row = await User.scope('withPassword').findByPk(T.staff.id);
    expect(row.firstName).toBe('Renamed');
    expect(row.isSystem).toBe(false);
    expect(row.permissionsVersion).not.toBe(999);
    expect((await login('staff@sec.test', 'taken-over-1')).status).toBe(401);
    expect((await login('staff@sec.test')).status).toBe(200);
  });

  it('refuses an EMPLOYEE_MODIFY holder editing or deleting the owner', async () => {
    const edit = await request(app).put(`/api/v1/users/${T.owner.id}`).set('Cookie', T.hrCookie).send({ phone: '1' });
    expect(edit.status).toBe(403);
    const deactivate = await request(app).put(`/api/v1/users/${T.owner.id}`).set('Cookie', T.hrCookie).send({ status: 'INACTIVE' });
    expect(deactivate.status).toBe(403);
    expect((await User.findByPk(T.owner.id)).status).toBe('ACTIVE');
  });

  it('still lets a full-access actor edit the owner', async () => {
    const res = await request(app).put(`/api/v1/users/${T.owner.id}`).set('Cookie', T.admin).send({ phone: '9999' });
    expect(res.status).toBe(200);
  });

  it('does not return reset-token state on user reads', async () => {
    const res = await request(app).get(`/api/v1/users/${T.staff.id}`).set('Cookie', T.admin);
    expect(res.status).toBe(200);
    expect(res.body.data).not.toHaveProperty('resetPasswordToken');
    expect(res.body.data).not.toHaveProperty('resetPasswordExpires');
  });
});

describe('F-02 / F-11: forgot-password never returns the link and answers uniformly', () => {
  it('keeps the link out of the response even when the email service hands it back', async () => {
    // What the old email service returned on an SMTP failure.
    jest.spyOn(emailService, 'sendPasswordResetEmail').mockResolvedValue({
      success: false, fallbackUrl: 'http://x/reset-password?token=LEAKED', error: 'smtp down',
    });

    const known = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'staff@sec.test' });
    const unknown = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'nobody@sec.test' });
    const owner = await request(app).post('/api/v1/auth/forgot-password').send({ email: 'owner@sec.test' });

    expect(JSON.stringify(known.body)).not.toMatch(/LEAKED|fallbackUrl|resetUrl|smtp down/);
    expect([known.status, unknown.status, owner.status]).toEqual([200, 200, 200]);
    expect(known.body).toEqual(unknown.body);
    expect(owner.body).toEqual(unknown.body);
    // The owner is still not resettable through the public link.
    expect(emailService.sendPasswordResetEmail).toHaveBeenCalledTimes(1);
  });
});

describe('W-07: a password reset ends sessions that are already open', () => {
  it('refuses the access token issued before the reset', async () => {
    let link;
    jest.spyOn(emailService, 'sendPasswordResetEmail').mockImplementation(async ({ resetUrl }) => {
      link = resetUrl;
      return { success: true };
    });

    const before = await loginAs('staff@sec.test');
    expect((await request(app).get('/api/v1/auth/me').set('Cookie', before)).status).toBe(200);

    await request(app).post('/api/v1/auth/forgot-password').send({ email: 'staff@sec.test' });
    const token = new URL(link).searchParams.get('token');
    const reset = await request(app).post('/api/v1/auth/reset-password').send({ token, newPassword: 'brand-new-pass' });
    expect(reset.status).toBe(200);

    expect((await request(app).get('/api/v1/auth/me').set('Cookie', before)).status).toBe(401);
    expect((await login('staff@sec.test', 'brand-new-pass')).status).toBe(200);
    // Put the shared fixture back.
    await User.update({ passwordHash: await bcrypt.hash(PASSWORD, 10) }, { where: { id: T.staff.id } });
  });
});

describe('F-03: rolling the financial year stays inside the tenant', () => {
  it('does not close another tenant\'s current year', async () => {
    const res = await request(app).put(`/api/v1/financial-years/${T.fyNext.id}/set-current`).set('Cookie', T.admin);
    expect(res.status).toBe(200);

    const mine = await FinancialYear.unscoped().findByPk(T.fyCurrent.id);
    const theirs = await FinancialYear.unscoped().findByPk(T.rivalFy.id);
    expect(mine.isCurrent).toBe(false);
    expect(theirs.isCurrent).toBe(true);
    expect(theirs.status).toBe('ACTIVE');
  });
});

describe('F-04: role membership cannot reach across tenants', () => {
  it('refuses to add another tenant\'s employee to a role', async () => {
    const roles = await request(app).post('/api/v1/roles').set('Cookie', T.admin).send({ name: 'Wide', permissions: ['*'] });
    expect(roles.status).toBe(201);
    const res = await request(app)
      .post(`/api/v1/roles/${roles.body.data.id}/members`)
      .set('Cookie', T.admin)
      .send({ employeeId: T.rivalUser.id });
    expect(res.status).toBe(404);
  });

  it('ignores a cross-tenant membership row at login', async () => {
    // A row like the one the old assignMember would have written.
    const role = await AdGroup.create({ tenantId: T.tenantId, name: 'Planted', permissions: ['*'] });
    await AdGroupMember.create({ tenantId: T.tenantId, adGroupId: role.id, employeeId: T.rivalUser.id });

    const res = await login('user@rival.test');
    expect(res.status).toBe(200);
    expect(res.body.data.user.permissions).not.toContain('*');
  });
});

describe('F-06: avatars are raster images only, served inertly', () => {
  const upload = (buffer, filename, contentType) =>
    request(app).post('/api/v1/users/avatar').set('Cookie', T.admin).attach('avatar', buffer, { filename, contentType });

  it('refuses SVG and HTML', async () => {
    expect((await upload(Buffer.from('<svg onload="alert(1)"/>'), 'x.svg', 'image/svg+xml')).status).toBe(400);
    expect((await upload(Buffer.from('<script>alert(1)</script>'), 'x.html', 'text/html')).status).toBe(400);
  });

  it('refuses a script that claims to be a PNG', async () => {
    expect((await upload(Buffer.from('<script>alert(1)</script>'), 'x.html', 'image/png')).status).toBe(400);
  });

  it('stores a real PNG under a server-chosen extension and serves it with nosniff', async () => {
    const res = await upload(PNG_1PX, 'evil.html', 'image/png');
    expect(res.status).toBe(201);
    expect(res.body.data.filename).toMatch(/\.png$/);

    const served = await request(app).get(res.body.data.url);
    expect(served.status).toBe(200);
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.headers['content-security-policy']).toMatch(/sandbox/);
    fs.unlinkSync(path.join(__dirname, '../uploads/avatars', res.body.data.filename));
  });

  it('does not serve non-image files from the uploads mounts', async () => {
    expect((await request(app).get('/uploads/avatars/anything.html')).status).toBe(404);
    expect((await request(app).get('/uploads/avatars/anything.js')).status).toBe(404);
  });
});
