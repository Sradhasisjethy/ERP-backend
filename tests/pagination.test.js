const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, Factory, FinancialYear, Party } = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;
let factory;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-pagination', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@pagination-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Pagination Factory', code: 'PG-FAC' });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@pagination-test.co', password: PASSWORD }), 'accessToken');

  // 25 expenses so the default 10-per-page window is exercised over 3 pages.
  for (let i = 1; i <= 25; i += 1) {
    await request(app)
      .post('/api/v1/expenses')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id, expenseDate: '2026-08-20',
        category: i % 2 === 0 ? 'Diesel' : 'Repairs',
        mode: 'BANK', amountPaise: 1000 * i, description: `Expense number ${i}`,
      });
  }

  await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Findable Customer Alpha' });
  await Party.create({ tenantId, partyType: 'VENDOR', name: 'Unrelated Vendor Beta' });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Shared list pagination contract', () => {
  it('defaults to 10 rows per page and reports the full envelope', async () => {
    const res = await request(app).get('/api/v1/expenses').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(10);
    expect(res.body.data.count).toBe(25);
    expect(res.body.data.page).toBe(1);
    expect(res.body.data.limit).toBe(10);
    expect(res.body.data.totalPages).toBe(3);
  });

  it('returns distinct rows for each page and a short final page', async () => {
    const p1 = await request(app).get('/api/v1/expenses?page=1').set('Cookie', adminCookie);
    const p2 = await request(app).get('/api/v1/expenses?page=2').set('Cookie', adminCookie);
    const p3 = await request(app).get('/api/v1/expenses?page=3').set('Cookie', adminCookie);

    expect(p3.body.data.rows).toHaveLength(5);
    const ids = [...p1.body.data.rows, ...p2.body.data.rows, ...p3.body.data.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(25); // no row appears on two pages, none skipped
  });

  it('honours an explicit limit', async () => {
    const res = await request(app).get('/api/v1/expenses?limit=4&page=2').set('Cookie', adminCookie);
    expect(res.body.data.rows).toHaveLength(4);
    expect(res.body.data.limit).toBe(4);
    expect(res.body.data.totalPages).toBe(7); // ceil(25/4)
  });

  it('rejects a limit above the cap rather than silently returning everything', async () => {
    const res = await request(app).get('/api/v1/expenses?limit=5000').set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });

  it('filters by free-text search and reflects the reduced count', async () => {
    const res = await request(app).get('/api/v1/expenses?search=Diesel').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(12); // even-numbered expenses
    expect(res.body.data.rows.every((r) => r.category === 'Diesel')).toBe(true);
  });

  it('searches across every configured column, not just the first', async () => {
    const res = await request(app).get('/api/v1/expenses?search=number 7').set('Cookie', adminCookie);
    expect(res.body.data.count).toBe(1); // matched on `description`
    expect(res.body.data.rows[0].description).toBe('Expense number 7');
  });

  it('applies search on a different module (parties) too', async () => {
    const res = await request(app).get('/api/v1/parties?search=Alpha').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.rows[0].name).toBe('Findable Customer Alpha');
  });

  it('combines search with an existing filter', async () => {
    const res = await request(app).get(`/api/v1/expenses?category=Repairs&search=number 1`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    // Odd-numbered (Repairs) expenses whose description contains "number 1": 1, 11, 13, 15, 17, 19
    expect(res.body.data.rows.every((r) => r.category === 'Repairs')).toBe(true);
    expect(res.body.data.count).toBe(6);
  });
});
