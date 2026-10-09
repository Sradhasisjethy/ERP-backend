/**
 * Regression tests for the 2026-10-09 secrets and data-exposure review
 * (findings D4–D7). Synthetic data only.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { logger, redactValue } = require('../src/utils/logger');
const { Tenant, User, Organization, AdGroup, AdGroupMember } = require('../src/models/index');

const PASSWORD = 'password123';
const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

/** Everything the logger was handed during `fn`, as one string. */
const captureLogs = async (fn) => {
  const seen = [];
  const spies = ['info', 'warn', 'error'].map((level) =>
    jest.spyOn(logger, level).mockImplementation((entry) => {
      seen.push(typeof entry === 'string' ? entry : JSON.stringify(redactValue(entry, undefined, 0)));
    })
  );
  try {
    await fn();
  } finally {
    spies.forEach((spy) => spy.mockRestore());
  }
  return seen.join('\n');
};

let T;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const tenant = await Tenant.create({ name: 'Exposure Co', slug: 'exposure-co', status: 'active' });
  const tenantId = tenant.id;
  await Organization.create({ tenantId, name: 'Exposure Pvt Ltd', code: 'EX' });
  const mk = (email, extra = {}) =>
    User.create({ tenantId, email, passwordHash, firstName: 'F', lastName: 'L', role: 'EMPLOYEE', status: 'ACTIVE', ...extra }, { validate: false });
  const grant = async (user, permissions) => {
    const group = await AdGroup.create({ tenantId, name: `G ${user.email}`, permissions });
    await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });
  };

  await mk('admin@exposure.test', { role: 'PLATFORM_ADMIN' });
  const staff = await mk('staff@exposure.test', { phone: '9000000001', address: '1 Test Lane', pincode: '751001' });
  await grant(staff, ['EMPLOYEE_READ']);
  const colleague = await mk('colleague@exposure.test', { phone: '9000000002', address: '2 Sample Road', pincode: '751002' });
  const hr = await mk('hr@exposure.test');
  await grant(hr, ['EMPLOYEE_READ', 'EMPLOYEE_MODIFY']);

  T = { staff, colleague, admin: await loginAs('admin@exposure.test') };
  T.staffCookie = await loginAs('staff@exposure.test');
  T.hrCookie = await loginAs('hr@exposure.test');
});

afterAll(async () => {
  await sequelize.close();
});

describe('D4: EMPLOYEE_READ is a directory, not the HR file', () => {
  it('hides a colleague\'s address and phone from ordinary staff', async () => {
    const one = await request(app).get(`/api/v1/users/${T.colleague.id}`).set('Cookie', T.staffCookie);
    expect(one.status).toBe(200);
    expect(JSON.stringify(one.body)).not.toMatch(/9000000002|2 Sample Road|751002/);
    expect(one.body.data.email).toBe('colleague@exposure.test');

    const list = await request(app).get('/api/v1/users?limit=50').set('Cookie', T.staffCookie);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toMatch(/9000000002|2 Sample Road/);
  });

  it('still shows your own record in full, and the full record to HR', async () => {
    const own = await request(app).get(`/api/v1/users/${T.staff.id}`).set('Cookie', T.staffCookie);
    expect(own.body.data.phone).toBe('9000000001');
    const hr = await request(app).get(`/api/v1/users/${T.colleague.id}`).set('Cookie', T.hrCookie);
    expect(hr.body.data.address).toBe('2 Sample Road');
  });
});

describe('D5: the access log carries no query string', () => {
  it('does not log search terms', async () => {
    const logged = await captureLogs(() =>
      request(app).get('/api/v1/users?search=999900001111').set('Cookie', T.admin)
    );
    expect(logged).toMatch(/GET \/api\/v1\/users /);
    expect(logged).not.toMatch(/999900001111/);
  });
});

describe('D6: structured log fields are redacted', () => {
  it('redacts identity, bank and token fields on a copy, and masks emails', () => {
    const entry = {
      message: 'x', quantity: 4, companyName: 'Keep Me',
      bankAccountNumber: '000111222333', aadhaarNumber: '999900001111', pan: 'ABCPE1234F',
      nested: { refreshToken: 'tok', email: 'someone@example.test' },
    };
    const out = JSON.stringify(redactValue(entry, undefined, 0));
    expect(out).not.toMatch(/000111222333|999900001111|ABCPE1234F|"tok"|someone@/);
    expect(out).toMatch(/Keep Me/);
    expect(out).toMatch(/"quantity":4/);
    expect(entry.bankAccountNumber).toBe('000111222333'); // the caller's object is untouched
  });
});

describe('D7: a duplicate does not put the colliding value in the log', () => {
  it('logs field names only', async () => {
    let res;
    const logged = await captureLogs(async () => {
      res = await request(app).post('/api/v1/users').set('Cookie', T.admin)
        .send({ email: 'colleague@exposure.test', firstName: 'Dup', lastName: 'Licate', sendInvite: false, password: 'a-long-password' });
    });
    expect(res.status).toBe(409);
    expect(logged).not.toMatch(/colleague@exposure\.test/);
  });
});
