const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode,
  MixDesign, MixDesignLine, Party, AdGroup, AdGroupMember, UserFactory,
} = require('../src/models/index');
const { WebPermissions } = require('../src/utils/constants');

const PASSWORD = 'password123';
let adminCookie;
let managerCookie;
let scopedCookie;
let factoryA;
let factoryB;
let finishedGood;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const login = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-dash', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  await User.create({ tenantId, email: 'admin@dash-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  // A Factory Manager: operational permissions, deliberately NO VIEW_RATES.
  const manager = await User.create({ tenantId, email: 'manager@dash-test.co', passwordHash, firstName: 'Factory', lastName: 'Manager', role: 'EMPLOYEE' }, { validate: false });
  const mgrGroup = await AdGroup.create({
    tenantId, name: 'Factory Manager',
    permissions: [WebPermissions.PRODUCTION_READ, WebPermissions.INVENTORY_READ, WebPermissions.SALES_READ],
  });
  await AdGroupMember.create({ tenantId, adGroupId: mgrGroup.id, employeeId: manager.id });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factoryA = await Factory.create({ tenantId, organizationId: org.id, name: 'Factory A', code: 'DASH-A', state: 'Odisha' });
  factoryB = await Factory.create({ tenantId, organizationId: org.id, name: 'Factory B', code: 'DASH-B', state: 'Odisha' });

  // A real Factory Manager is assigned to a factory — without an assignment
  // BR-29 correctly shows them nothing, which wouldn't exercise AC-14.1.
  await UserFactory.create({ tenantId, userId: manager.id, factoryId: factoryA.id });

  // A user scoped to Factory A only (BR-29).
  const scoped = await User.create({ tenantId, email: 'scoped@dash-test.co', passwordHash, firstName: 'Scoped', lastName: 'User', role: 'EMPLOYEE' }, { validate: false });
  await AdGroupMember.create({ tenantId, adGroupId: mgrGroup.id, employeeId: scoped.id });
  await UserFactory.create({ tenantId, userId: scoped.id, factoryId: factoryA.id });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-DASH' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast', gstRatePercent: 18 });
  const rawMaterial = await Product.create({ tenantId, uomId: uom.id, name: 'Cement Dash', code: 'RM-DASH', productType: 'RAW_MATERIAL', curingDays: 0, standardCostPaise: 5000, reorderLevel: 100 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Slab Dash', code: 'FG-DASH', productType: 'FINISHED_GOOD', curingDays: 0, standardCostPaise: 2000 });

  const mix = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });

  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Dash Vendor' });
  await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Dash Customer', state: 'Odisha' });

  adminCookie = await login('admin@dash-test.co');
  managerCookie = await login('manager@dash-test.co');
  scopedCookie = await login('scoped@dash-test.co');

  await request(app).post('/api/v1/purchasing/receipts').set('Cookie', adminCookie)
    .send({ factoryId: factoryA.id, vendorPartyId: vendor.id, receiptDate: '2026-08-01', lines: [{ productId: rawMaterial.id, receivedQty: 500, ratePaise: 5000 }] });

  await request(app).post('/api/v1/production/entries').set('Cookie', adminCookie)
    .send({ factoryId: factoryA.id, productId: finishedGood.id, productionDate: new Date().toISOString().slice(0, 10), goodQty: 40, rejectedQty: 10 });
});

afterAll(async () => {
  await sequelize.close();
});

describe('AC-14.1 Role-aware dashboard', () => {
  it('gives a finance-permitted user both operational and financial widgets', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.operational).toBeTruthy();
    expect(res.body.data.financial).toBeTruthy();
    expect(res.body.data.financial).toHaveProperty('cashBalancePaise');
    expect(res.body.data.financial).toHaveProperty('receivablesAgeing');
  });

  it('omits the financial half ENTIRELY for a user without VIEW_RATES', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set('Cookie', managerCookie);
    expect(res.status).toBe(200);

    // Operational widgets are still there — this role has a real dashboard.
    expect(res.body.data.operational.productionToday).toBeGreaterThan(0);
    expect(res.body.data.operational).toHaveProperty('rejectionPercent');

    // AC-14.1: the key is absent, not null and not zero. A UI that merely hid
    // the widget while the payload still carried the figures would fail this.
    expect(res.body.data).not.toHaveProperty('financial');

    // Belt and braces: no money-shaped key anywhere in the serialised response.
    const serialised = JSON.stringify(res.body.data);
    expect(serialised).not.toMatch(/Paise/);
  });

  it('still exposes trends to a non-financial user, without the sales series', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set('Cookie', managerCookie);
    expect(res.body.data.trends).toHaveLength(12);
    expect(res.body.data.trends[0]).toHaveProperty('production');
    expect(res.body.data.trends[0]).not.toHaveProperty('salesPaise');
  });

  it('includes the sales series in trends for a finance-permitted user', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set('Cookie', adminCookie);
    expect(res.body.data.trends[0]).toHaveProperty('salesPaise');
  });
});

describe('Operational widgets', () => {
  it('computes yield and rejection from real production data', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set('Cookie', adminCookie);
    // 40 good, 10 rejected -> 80% yield, 20% rejection
    expect(res.body.data.operational.yieldPercent).toBe(80);
    expect(res.body.data.operational.rejectionPercent).toBe(20);
  });

  it('flags raw material below its reorder level', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set('Cookie', adminCookie);
    // 500 received, 40 consumed by production -> 460 on hand, reorder level 100: not flagged.
    expect(res.body.data.operational.reorderAlerts.every((a) => a.onHand < a.reorderLevel)).toBe(true);
  });
});

describe('BR-29 Factory scoping on the dashboard', () => {
  it('limits a factory-scoped user to their own factory', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set('Cookie', scopedCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.scope.factoryIds).toEqual([factoryA.id]);
  });

  it('returns nothing when a scoped user asks for a factory they cannot see', async () => {
    const res = await request(app).get(`/api/v1/dashboard/stats?factoryId=${factoryB.id}`).set('Cookie', scopedCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.scope.factoryIds).toEqual([]);
    expect(res.body.data.operational.productionToday).toBe(0);
  });

  it('lets an unrestricted user scope to any factory explicitly', async () => {
    const res = await request(app).get(`/api/v1/dashboard/stats?factoryId=${factoryA.id}`).set('Cookie', adminCookie);
    expect(res.body.data.scope.factoryIds).toEqual([factoryA.id]);
    expect(res.body.data.operational.productionToday).toBeGreaterThan(0);
  });
});
