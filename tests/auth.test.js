const request = require('supertest');
const jwt = require('jsonwebtoken');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { Tenant, Organization, AdGroup, AdGroupMember, User } = require('../src/models/index');

const PASSWORD = 'password123';

let regularUser;
let noRoleUser;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  if (!match) return null;
  return match.split(';')[0];
};

beforeAll(async () => {
  await sequelize.sync({ force: true });

  const tenant = await Tenant.create({ name: 'Test Co', slug: 'test-co', status: 'active' });
  const org = await Organization.create({ tenantId: tenant.id, name: 'Test Org', status: 'active' });

  const role = await AdGroup.create({
    tenantId: tenant.id,
    name: 'Reader',
    permissions: ['EMPLOYEE_READ'],
    status: 'active',
  });

  const bcrypt = require('bcryptjs');
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  regularUser = await User.create(
    {
      tenantId: tenant.id,
      organizationId: org.id,
      email: 'reader@test.co',
      passwordHash,
      firstName: 'Reader',
      lastName: 'User',
      role: 'EMPLOYEE',
    },
    { validate: false }
  );

  noRoleUser = await User.create(
    {
      tenantId: tenant.id,
      organizationId: org.id,
      email: 'norole@test.co',
      passwordHash,
      firstName: 'NoRole',
      lastName: 'User',
      role: 'EMPLOYEE',
    },
    { validate: false }
  );

  await AdGroupMember.create({ tenantId: tenant.id, adGroupId: role.id, employeeId: regularUser.id });
});

afterAll(async () => {
  await sequelize.close();
});

describe('GET /health', () => {
  it('returns 200 ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
  });
});

describe('unmatched routes', () => {
  it('returns a JSON 404 instead of the Express default HTML page', async () => {
    // A path outside every mounted router. (Anything under /api/v1/* that isn't
    // /auth or /users falls through to organizationRouter, which applies
    // `authenticate` first — so an unauthenticated request there 401s before
    // ever reaching the 404 handler. That's the existing route mount structure,
    // not something this test is checking.)
    const res = await request(app).get('/this-route-does-not-exist-anywhere');
    expect(res.status).toBe(404);
    expect(res.body.success).toBe(false);
  });
});

describe('RBAC: login -> JWT permissions -> authorize()', () => {
  it('login issues an access token carrying the permissions from the assigned AdGroup', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'reader@test.co', password: PASSWORD });

    expect(res.status).toBe(200);
    const accessTokenCookie = extractCookie(res, 'accessToken');
    expect(accessTokenCookie).toBeTruthy();

    const token = accessTokenCookie.split('=')[1];
    const decoded = jwt.decode(token);
    expect(decoded.permissions).toContain('EMPLOYEE_READ');
  });

  it('a user with the required permission can access a permission-gated route', async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'reader@test.co', password: PASSWORD });
    const cookie = extractCookie(loginRes, 'accessToken');

    const res = await request(app).get('/api/v1/users').set('Cookie', cookie);
    expect(res.status).toBe(200);
  });

  it('a user with no assigned role/permissions is rejected by authorize()', async () => {
    const loginRes = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'norole@test.co', password: PASSWORD });
    const cookie = extractCookie(loginRes, 'accessToken');

    const res = await request(app).get('/api/v1/users').set('Cookie', cookie);
    expect(res.status).toBe(403);
  });
});
