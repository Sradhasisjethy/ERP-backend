/**
 * Regression tests for review findings N3, N7 and N12 (2026-10-09): the plant
 * code that flows into document numbers and PDF headers, the labour statutory
 * checks that lived only in the browser, and the reason-code update route that
 * had no schema. Each refused request here succeeded before the fix, and the
 * non-ASCII print was a 500.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { runInTenantContext } = require('./helpers/tenant');
const { DocumentNumberingService } = require('../src/api/documentSeries/documentNumbering.service');
const {
  Tenant, User, Organization, Factory, FinancialYear, Party, SalesOrder, DeliveryChallan,
} = require('../src/models/index');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

const as = (cookie) => ({
  get: (p) => request(app).get(p).set('Cookie', cookie),
  post: (p, b) => request(app).post(p).set('Cookie', cookie).send(b || {}),
  put: (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {}),
});

// A date of birth `years` before today, so the age checks never drift.
const yearsAgo = (years) => {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
};

let T;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const tenant = await Tenant.create({ name: 'Inputs Co', slug: 'inputs-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Inputs Pvt Ltd', code: 'IN' });
  // The current April-March year, so numbering and prints see an open period.
  const [ty, tm] = new Date().toISOString().slice(0, 10).split('-').map(Number);
  const start = tm >= 4 ? ty : ty - 1;
  const fy = await FinancialYear.create({
    tenantId, code: `${start}-${String(start + 1).slice(2)}`, startDate: `${start}-04-01`, endDate: `${start + 1}-03-31`,
    isCurrent: true, status: 'ACTIVE',
  });

  // Written straight through the model, as a row saved before the code rule
  // existed would be: a non-Latin-1 code with a quote in it.
  const legacyPlant = await Factory.create({ tenantId, organizationId: org.id, name: 'Legacy Plant', code: 'प्लांट"1', state: 'Odisha' });
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Customer', state: 'Odisha' });
  const order = await SalesOrder.create({
    tenantId, factoryId: legacyPlant.id, orderNumber: 'SO/प्लांट"1/0001', customerPartyId: customer.id, orderDate: '2026-08-01', status: 'CONFIRMED',
  });
  // The number such a plant got from the old default prefix.
  const challan = await DeliveryChallan.create({
    tenantId, factoryId: legacyPlant.id, challanNumber: 'DC/प्लांट"1/0001', salesOrderId: order.id, vehicleNumber: 'OD02AB1234', dispatchDate: '2026-08-02',
  });

  await User.create(
    { tenantId, email: 'admin@inputs.test', passwordHash, firstName: 'A', lastName: 'D', role: 'PLATFORM_ADMIN', status: 'ACTIVE' },
    { validate: false }
  );

  T = { tenantId, org, fy, legacyPlant, challan };
  T.admin = await loginAs('admin@inputs.test');
});

afterAll(async () => {
  await sequelize.close();
});

describe('N3: plant code is constrained and cannot break document numbers or PDF headers', () => {
  it('refuses a code with a quote in it', async () => {
    const res = await as(T.admin).post('/api/v1/factories', { organizationId: T.org.id, name: 'Quote Plant', code: 'A"B' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Code must be 1-10 characters/);
  });

  it('refuses a code longer than ten characters', async () => {
    const res = await as(T.admin).post('/api/v1/factories', { organizationId: T.org.id, name: 'Long Plant', code: 'ABCDEFGHIJK' });
    expect(res.status).toBe(400);
  });

  it('accepts a lowercase code and stores it uppercased', async () => {
    const res = await as(T.admin).post('/api/v1/factories', { organizationId: T.org.id, name: 'Plant One', code: ' pl-01 ' });
    expect(res.status).toBe(201);
    expect(res.body.data.code).toBe('PL-01');
    T.plantOne = res.body.data;
  });

  it('still saves an unrelated edit to a plant whose legacy code the rule rejects', async () => {
    const res = await as(T.admin).put(`/api/v1/factories/${T.legacyPlant.id}`, { name: 'Legacy Plant North' });
    expect(res.status).toBe(200);
  });

  it('keeps a valid code in the default prefix exactly as before', async () => {
    const { documentNumber } = await runInTenantContext(T.tenantId, () =>
      DocumentNumberingService.allocate('N3_TEST', { factoryId: T.plantOne.id, financialYearId: T.fy.id })
    );
    expect(documentNumber).toBe('N3_TEST/PL-01/0001');
  });

  it('drops the unusable parts of a legacy code from a new series', async () => {
    const { documentNumber } = await runInTenantContext(T.tenantId, () =>
      DocumentNumberingService.allocate('N3_TEST', { factoryId: T.legacyPlant.id, financialYearId: T.fy.id })
    );
    // Only the "1" survives: the Devanagari and the quote are not [A-Z0-9-].
    expect(documentNumber).toBe('N3_TEST/1/0001');
  });

  it('prints a challan whose number carries a non-ASCII code and a quote', async () => {
    const res = await as(T.admin).get(`/api/v1/dispatch/challans/${T.challan.id}/print`);
    expect(res.status).toBe(200);
    const disposition = res.headers['content-disposition'];
    expect(disposition).toMatch(/^inline; /);
    expect(disposition).toMatch(/filename\*=UTF-8''/);
    // The quoted ASCII form is printable ASCII with the quote replaced.
    expect(disposition).toMatch(/filename="DC-[^"]*-0001\.pdf";/);
    expect(disposition).not.toMatch(/[^\x20-\x7e]/);
  });
});

describe('N7: labour statutory checks are enforced by the server', () => {
  const labour = (extra) => ({ partyType: 'LABOUR', name: 'Worker', ...extra });

  it('refuses a labourer under 18', async () => {
    const res = await as(T.admin).post('/api/v1/parties', labour({ dateOfBirth: yearsAgo(10) }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at least 18/);
  });

  it('accepts an adult labourer', async () => {
    const res = await as(T.admin).post('/api/v1/parties', labour({ name: 'Adult Worker', dateOfBirth: yearsAgo(30) }));
    expect(res.status).toBe(201);
  });

  it('refuses a date of birth that is not YYYY-MM-DD', async () => {
    const res = await as(T.admin).post('/api/v1/parties', labour({ dateOfBirth: '15/05/1990' }));
    expect(res.status).toBe(400);
  });

  it('refuses an Aadhaar that is not 12 digits', async () => {
    const res = await as(T.admin).post('/api/v1/parties', labour({ aadhaarNumber: '1234' }));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/12 digits/);
  });

  it('accepts a 12-digit Aadhaar, stripping spaces', async () => {
    const res = await as(T.admin).post('/api/v1/parties', labour({ name: 'Aadhaar Worker', aadhaarNumber: '9999 0000 1111' }));
    expect(res.status).toBe(201);
    const stored = await Party.scope('withSensitive').findByPk(res.body.data.id);
    expect(stored.aadhaarNumber).toBe('999900001111');
    T.aadhaarWorker = stored;
  });

  it('lets the edit form send back masked values unchanged', async () => {
    const res = await as(T.admin).put(`/api/v1/parties/${T.aadhaarWorker.id}`, {
      name: 'Aadhaar Worker Renamed', aadhaarNumber: '••••••••1111', dateOfBirth: '••••••••',
    });
    expect(res.status).toBe(200);
    const stored = await Party.scope('withSensitive').findByPk(T.aadhaarWorker.id);
    expect(stored.aadhaarNumber).toBe('999900001111');
  });

  it('does not re-check stored values on an unrelated edit', async () => {
    const legacy = await Party.create({
      tenantId: T.tenantId, partyType: 'LABOUR', name: 'Legacy Worker', aadhaarNumber: '12', dateOfBirth: yearsAgo(16),
    });
    const res = await as(T.admin).put(`/api/v1/parties/${legacy.id}`, { phone: '9876543210' });
    expect(res.status).toBe(200);
  });

  it('leaves other party types alone', async () => {
    const res = await as(T.admin).post('/api/v1/parties', { partyType: 'CUSTOMER', name: 'Young Customer', dateOfBirth: yearsAgo(10) });
    expect(res.status).toBe(201);
  });
});

describe('N12: reason-code update has a schema and finds the code case-insensitively', () => {
  beforeAll(async () => {
    const res = await as(T.admin).post('/api/v1/bundles/reason-codes', { code: 'damaged', label: 'Damaged', requiresNote: false });
    expect(res.status).toBe(201);
  });

  it('refuses an empty label', async () => {
    expect((await as(T.admin).put('/api/v1/bundles/reason-codes/DAMAGED', { label: '' })).status).toBe(400);
  });

  it('refuses a key it does not declare', async () => {
    expect((await as(T.admin).put('/api/v1/bundles/reason-codes/DAMAGED', { code: 'OTHER' })).status).toBe(400);
  });

  it('updates the code when the URL spells it in lowercase', async () => {
    const res = await as(T.admin).put('/api/v1/bundles/reason-codes/damaged', { label: 'Ok' });
    expect(res.status).toBe(200);
    expect(res.body.data.label).toBe('Ok');
    expect(res.body.data.code).toBe('DAMAGED');
  });
});
