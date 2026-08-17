const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User } = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'CRUD Test Co', slug: 'crud-test-co', status: 'active' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    {
      tenantId: tenant.id,
      email: 'admin@crud-test.co',
      passwordHash,
      firstName: 'Admin',
      lastName: 'User',
      role: 'PLATFORM_ADMIN',
    },
    { validate: false }
  );

  const login = await request(app).post('/api/v1/auth/login').send({ email: 'admin@crud-test.co', password: PASSWORD });
  adminCookie = extractCookie(login, 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

/**
 * Regression coverage for two bugs that made every create/update/delete on a
 * tenant-scoped model fail: (1) BaseScopedModel injected tenantId in beforeCreate,
 * which runs *after* Sequelize's own allowNull validation already rejected the
 * still-null tenantId; (2) beforeDestroy was declared with the wrong hook
 * signature, which shadowed the instance's `where()` method and crashed
 * `.destroy()`. See src/core/BaseModel.js.
 */
describe('Organization CRUD (tenant-scoped model create/update/delete)', () => {
  let organizationId;

  it('creates an organization with the tenant auto-assigned', async () => {
    const res = await request(app)
      .post('/api/v1/organizations')
      .set('Cookie', adminCookie)
      .send({ name: 'Test Org', code: 'TO' });

    expect(res.status).toBe(201);
    expect(res.body.data.tenantId).toBeTruthy();
    organizationId = res.body.data.id;
  });

  it('updates the organization', async () => {
    const res = await request(app)
      .put(`/api/v1/organizations/${organizationId}`)
      .set('Cookie', adminCookie)
      .send({ status: 'inactive' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('inactive');
  });

  it('deletes the organization', async () => {
    const res = await request(app).delete(`/api/v1/organizations/${organizationId}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);

    const check = await request(app).get(`/api/v1/organizations/${organizationId}`).set('Cookie', adminCookie);
    expect(check.status).toBe(404);
  });
});
