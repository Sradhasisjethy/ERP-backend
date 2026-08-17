const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, MixDesign, MixDesignLine, Party, AdGroup, AdGroupMember,
} = require('../src/models/index');
const { WebPermissions } = require('../src/utils/constants');

const PASSWORD = 'password123';
let adminCookie;
let restrictedCookie;
let factory;
let finishedGood;
let customer;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-reports', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@reports-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  // An ordinary user who may read/write reports but has no VIEW_RATES — the BR-27 case.
  const clerk = await User.create(
    { tenantId, email: 'clerk@reports-test.co', passwordHash, firstName: 'Clerk', lastName: 'User', role: 'EMPLOYEE' },
    { validate: false }
  );
  const clerkGroup = await AdGroup.create({
    tenantId,
    name: 'Report Viewers',
    permissions: [WebPermissions.REPORT_READ, WebPermissions.REPORT_WRITE, WebPermissions.ANALYTICS_READ],
  });
  await AdGroupMember.create({ tenantId, adGroupId: clerkGroup.id, employeeId: clerk.id });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Reports Factory', code: 'RPT-FAC', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-RPT' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast', gstRatePercent: 18 });
  const rawMaterial = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Cement RPT', code: 'RM-CEMENT-RPT', productType: 'RAW_MATERIAL', curingDays: 0, standardCostPaise: 5000 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Precast Slab RPT', code: 'FG-SLAB-RPT', productType: 'FINISHED_GOOD', curingDays: 0, standardCostPaise: 0 });

  const mixDesign = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mixDesign.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 2, uomId: uom.id });

  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'RPT Vendor' });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'RPT Customer', state: 'Odisha' });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@reports-test.co', password: PASSWORD }), 'accessToken');
  restrictedCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'clerk@reports-test.co', password: PASSWORD }), 'accessToken');

  await request(app)
    .post('/api/v1/purchasing/receipts')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-01', lines: [{ productId: rawMaterial.id, receivedQty: 200, ratePaise: 5000 }] });

  await request(app)
    .post('/api/v1/production/entries')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, productId: finishedGood.id, productionDate: '2026-08-02', goodQty: 30 });

  // A goods receipt moves stock but posts no journal, so the ledger would
  // otherwise be empty — this expense gives the trial-balance report real
  // rows to return (Debit FACTORY_EXPENSE 5900, Credit BANK 1010).
  await request(app)
    .post('/api/v1/expenses')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, expenseDate: '2026-08-03', category: 'Diesel', mode: 'BANK', amountPaise: 25000 });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Report builder (M40)', () => {
  it('runs an ad-hoc report without saving it', async () => {
    const res = await request(app)
      .post('/api/v1/reports/run')
      .set('Cookie', adminCookie)
      .send({ reportType: 'STOCK_AGEING', params: { factoryId: factory.id, deadStockDays: 30 } });
    expect(res.status).toBe(200);
    expect(res.body.data.buckets).toBeTruthy();
    expect(res.body.data.lots.length).toBeGreaterThan(0);
  });

  it('saves a report and re-runs it by id', async () => {
    const created = await request(app)
      .post('/api/v1/reports')
      .set('Cookie', adminCookie)
      .send({ name: 'Monthly Trial Balance', reportType: 'TRIAL_BALANCE', params: { factoryId: factory.id } });
    expect(created.status).toBe(201);
    expect(created.body.data.name).toBe('Monthly Trial Balance');

    const run = await request(app).post(`/api/v1/reports/${created.body.data.id}/run`).set('Cookie', adminCookie).send({});
    expect(run.status).toBe(200);
    expect(Array.isArray(run.body.data)).toBe(true);
    expect(run.body.data.some((r) => r.code === '5900')).toBe(true); // FACTORY_EXPENSE, from the seeded expense
  });

  it('lets a saved report be re-run with overridden params', async () => {
    const created = await request(app)
      .post('/api/v1/reports')
      .set('Cookie', adminCookie)
      .send({ name: 'Dead Stock', reportType: 'STOCK_AGEING', params: { factoryId: factory.id, deadStockDays: 9999 } });

    const overridden = await request(app)
      .post(`/api/v1/reports/${created.body.data.id}/run`)
      .set('Cookie', adminCookie)
      .send({ params: { deadStockDays: 1 } });
    expect(overridden.status).toBe(200);
    // The saved threshold (9999) would flag nothing; the override (1) flags everything.
    expect(overridden.body.data.deadStockDays).toBe(1);
    expect(overridden.body.data.deadStock.length).toBeGreaterThan(0);
  });

  it('lists and deletes saved reports', async () => {
    const list = await request(app).get('/api/v1/reports').set('Cookie', adminCookie);
    expect(list.status).toBe(200);
    expect(list.body.data.count).toBe(2);

    const deleted = await request(app).delete(`/api/v1/reports/${list.body.data.rows[0].id}`).set('Cookie', adminCookie);
    expect(deleted.status).toBe(200);

    const after = await request(app).get('/api/v1/reports').set('Cookie', adminCookie);
    expect(after.body.data.count).toBe(1);
  });

  it('rejects an unknown report type', async () => {
    const res = await request(app)
      .post('/api/v1/reports/run')
      .set('Cookie', adminCookie)
      .send({ reportType: 'NOT_A_REPORT', params: {} });
    expect(res.status).toBe(400);
  });

  it('masks money fields for a user without VIEW_RATES (BR-27)', async () => {
    const withRates = await request(app)
      .post('/api/v1/reports/run')
      .set('Cookie', adminCookie)
      .send({ reportType: 'TRIAL_BALANCE', params: { factoryId: factory.id } });
    expect(withRates.body.data.some((r) => r.balancePaise !== null)).toBe(true);

    const withoutRates = await request(app)
      .post('/api/v1/reports/run')
      .set('Cookie', restrictedCookie)
      .send({ reportType: 'TRIAL_BALANCE', params: { factoryId: factory.id } });
    expect(withoutRates.status).toBe(200);
    expect(withoutRates.body.data.length).toBeGreaterThan(0);
    expect(withoutRates.body.data.every((r) => r.balancePaise === null && r.totalDebitPaise === null && r.totalCreditPaise === null)).toBe(true);
  });

  it('masks a saved stock-ageing report for a user without VIEW_RATES', async () => {
    const created = await request(app)
      .post('/api/v1/reports')
      .set('Cookie', restrictedCookie)
      .send({ name: 'Clerk Ageing', reportType: 'STOCK_AGEING', params: { factoryId: factory.id } });

    const run = await request(app).post(`/api/v1/reports/${created.body.data.id}/run`).set('Cookie', restrictedCookie).send({});
    expect(run.status).toBe(200);
    expect(run.body.data.lots.every((l) => l.valuePaise === null)).toBe(true);
    expect(Object.values(run.body.data.buckets).every((b) => b.valuePaise === null)).toBe(true);
    // Non-money fields must still come through — masking, not blanking.
    expect(run.body.data.lots.every((l) => typeof l.qtyAvailable === 'number')).toBe(true);
  });
});
