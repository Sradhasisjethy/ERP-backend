/**
 * Regression tests for the 2026-10-09 input-handling re-review (N11): client
 * errors are 4xx, not 500. Synthetic data only.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization } = require('../src/models/index');

let cookie;

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Extra Co', slug: 'extra-co', status: 'active' });
  await Organization.create({ tenantId: tenant.id, name: 'Extra Pvt Ltd', code: 'XE' });
  await User.create(
    { tenantId: tenant.id, email: 'admin@extra.test', passwordHash: await bcrypt.hash('password123', 10), firstName: 'A', lastName: 'A', role: 'PLATFORM_ADMIN', status: 'ACTIVE' },
    { validate: false }
  );
  const login = await request(app).post('/api/v1/auth/login').send({ email: 'admin@extra.test', password: 'password123' });
  cookie = (login.headers['set-cookie'] || []).find((c) => c.startsWith('accessToken=')).split(';')[0];
});

afterAll(async () => {
  await sequelize.close();
});

describe('N11: client errors are 4xx', () => {
  it('a NUL byte in a text field is a 400', async () => {
    const res = await request(app).post('/api/v1/parties').set('Cookie', cookie)
      .send({ partyType: 'CUSTOMER', name: 'a\u0000b', code: 'NUL-1', state: 'Odisha' });
    expect(res.status).toBe(400);
  });

  it('an unsupported body charset is a 415', async () => {
    const res = await request(app).post('/api/v1/parties').set('Cookie', cookie)
      .set('Content-Type', 'application/json; charset=klingon').send('{}');
    expect(res.status).toBe(415);
  });

  it('a refused CORS origin is a 403', async () => {
    const res = await request(app).get('/health/live').set('Origin', 'https://evil.example');
    expect(res.status).toBe(403);
  });
});
