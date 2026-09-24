const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Party } = require('../src/models/index');

/**
 * Narrowing a party list to several kinds at once.
 *
 * The payment screen is labelled "Vendor / Contractor / Labour" and the advance
 * screen "Contractor / Labourer", but the list endpoint could only filter on one
 * type. Both worked around it by asking for every party, so a money-out form
 * offered customers, and the advance form concatenated two capped pages and lost
 * every contractor past the hundredth.
 */

const PASSWORD = 'password123';
let api;
let tenantId;

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Filter Co', slug: 'filter-co', status: 'active' });
  tenantId = tenant.id;
  await User.create(
    { tenantId, email: 'admin@filter.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Asha', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  await Party.bulkCreate(
    [
      { tenantId, partyType: 'CUSTOMER', name: 'Apex Buildcon', code: 'CUST-01' },
      { tenantId, partyType: 'VENDOR', name: 'Odisha Cement', code: 'VEND-01' },
      { tenantId, partyType: 'CONTRACTOR', name: 'Sahoo Contractors', code: 'CONT-01' },
      { tenantId, partyType: 'LABOUR', name: 'Ajay Behera', code: 'LABR-01' },
      { tenantId, partyType: 'SALES_REF', name: 'Ravi Agent', code: 'REF-01' },
    ],
    { individualHooks: true, validate: true }
  );

  const login = await request(app).post('/api/v1/auth/login').send({ email: 'admin@filter.co', password: PASSWORD });
  const cookie = (login.headers['set-cookie'] || []).find((c) => c.startsWith('accessToken=')).split(';')[0];
  api = (query) => request(app).get('/api/v1/parties').set('Cookie', cookie).query({ limit: 50, ...query });
});

afterAll(async () => {
  await sequelize.close();
});

const typesIn = (res) => [...new Set(res.body.data.rows.map((row) => row.partyType))].sort();

describe('Listing parties by kind', () => {
  it('returns every kind when nothing is asked for', async () => {
    const res = await api({});
    expect(res.status).toBe(200);
    expect(typesIn(res)).toEqual(['CONTRACTOR', 'CUSTOMER', 'LABOUR', 'SALES_REF', 'VENDOR']);
  });

  it('narrows to the several kinds a payment can go to', async () => {
    const res = await api({ partyTypes: 'VENDOR,CONTRACTOR,LABOUR' });
    expect(res.status).toBe(200);
    expect(typesIn(res)).toEqual(['CONTRACTOR', 'LABOUR', 'VENDOR']);
    // The point of the filter: a customer cannot be paid from the money-out form.
    expect(res.body.data.rows.map((row) => row.name)).not.toContain('Apex Buildcon');
  });

  it('forgives spaces around the commas', async () => {
    const res = await api({ partyTypes: 'CONTRACTOR, LABOUR' });
    expect(typesIn(res)).toEqual(['CONTRACTOR', 'LABOUR']);
  });

  it('still honours the single partyType every other screen sends', async () => {
    const res = await api({ partyType: 'CUSTOMER' });
    expect(typesIn(res)).toEqual(['CUSTOMER']);
  });

  it('refuses a kind that does not exist rather than quietly ignoring it', async () => {
    const res = await api({ partyTypes: 'VENDOR,SUPPLIER' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/comma separated list of party types/);
  });

  it('searches within the narrowed kinds, which is what the picker does', async () => {
    const res = await api({ partyTypes: 'VENDOR,CONTRACTOR,LABOUR', search: 'a' });
    expect(res.status).toBe(200);
    expect(res.body.data.rows.every((row) => row.partyType !== 'CUSTOMER')).toBe(true);
  });
});
