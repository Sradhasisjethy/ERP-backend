// A lot's curing clock runs from its origin date (BR-08), so a test asserting
// CURING must receive stock *today* — a hardcoded date silently stops testing
// anything the moment the wall clock passes it, which is exactly what happened:
// both curing assertions had been failing for days against a fixed 2026-08-10.
const today = () => new Date().toISOString().slice(0, 10);

const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, MixDesign, MixDesignLine, Party, AdGroup, AdGroupMember,
} = require('../src/models/index');
const { WebPermissions } = require('../src/utils/constants');

const PASSWORD = 'password123';
let adminCookie;
let limitedCookie;
let factory;
let rawMaterial;
let finishedGood;
let vendor;
let customer;
let productionPlanLineId;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) => extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-sp', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  await User.create({ tenantId, email: 'admin@sp-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });
  const limitedUser = await User.create({ tenantId, email: 'sales@sp-test.co', passwordHash, firstName: 'Sales', lastName: 'User', role: 'EMPLOYEE' }, { validate: false });
  const limitedGroup = await AdGroup.create({
    tenantId,
    name: 'Sales & Production',
    permissions: [
      WebPermissions.SALES_READ, WebPermissions.SALES_WRITE,
      WebPermissions.PRODUCTION_READ, WebPermissions.PRODUCTION_WRITE,
      WebPermissions.WASTAGE_READ, WebPermissions.WASTAGE_WRITE,
    ],
  });
  await AdGroupMember.create({ tenantId, adGroupId: limitedGroup.id, employeeId: limitedUser.id });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'SP Factory', code: 'SP-FAC', varianceThresholdPercent: 5 });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-SP' });
  rawMaterial = await Product.create({ tenantId, uomId: uom.id, name: 'Cement SP', code: 'RM-CEMENT-SP', productType: 'RAW_MATERIAL', curingDays: 0 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, name: 'Precast Slab SP', code: 'FG-SLAB-SP', productType: 'FINISHED_GOOD', curingDays: 3 });

  const mixDesign = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mixDesign.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 2, uomId: uom.id });

  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'SP Vendor' });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'SP Customer', creditLimitPaise: 1000, creditAction: 'BLOCK' });

  adminCookie = await loginAs('admin@sp-test.co');
  limitedCookie = await loginAs('sales@sp-test.co');

  // Stock 200 units of raw material so production has material to consume.
  await request(app)
    .post('/api/v1/purchasing/receipts')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-10', lines: [{ productId: rawMaterial.id, receivedQty: 200, ratePaise: 5000 }] });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Sales Order (M06/M07, BR-11, BR-12, BR-13, BR-16)', () => {
  let orderId;

  it('creates a DRAFT order and confirms it', async () => {
    const create = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-10', lines: [{ productId: finishedGood.id, orderedQty: 10, ratePaise: 100 }] });
    expect(create.status).toBe(201);
    orderId = create.body.data.id;
    expect(create.body.data.status).toBe('DRAFT');

    const confirm = await request(app).put(`/api/v1/sales/orders/${orderId}/confirm`).set('Cookie', adminCookie);
    expect(confirm.status).toBe(200);
    expect(confirm.body.data.status).toBe('CONFIRMED');
  });

  it('reports zero available and books the whole order as a production requirement when there is no stock', async () => {
    const res = await request(app).get(`/api/v1/sales/atp?factoryId=${factory.id}&productId=${finishedGood.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    // Availability is a real quantity, so it floors at zero — unmet demand is
    // expressed as the line's productionRequired (BR-12), not as negative stock.
    expect(res.body.data.availableToPromise).toBe(0);
    expect(res.body.data.onHand).toBe(0);
    expect(res.body.data.reserved).toBe(0); // nothing could be held, there was nothing to hold

    const order = await request(app).get(`/api/v1/sales/orders/${orderId}`).set('Cookie', adminCookie);
    expect(Number(order.body.data.lines[0].productionRequired)).toBe(10);
  });

  it('blocks a new order over the credit limit for a user without SALES_CREDIT_OVERRIDE', async () => {
    const res = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', limitedCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-10', lines: [{ productId: finishedGood.id, orderedQty: 1, ratePaise: 100000 }] });
    expect(res.status).toBe(403);
  });

  it('allows the same over-limit order with an explicit override by a permitted user, and surfaces a warning', async () => {
    const res = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-10', allowCreditOverride: true, lines: [{ productId: finishedGood.id, orderedQty: 1, ratePaise: 100000 }] });
    expect(res.status).toBe(201);
    expect(res.body.data.creditWarning).toBeTruthy();
  });

  it('cancels an order with no dispatch, but rejects cancellation without a reason', async () => {
    // allowCreditOverride: true — this customer already carries open orders
    // from the credit-limit tests above, so any further order for them would
    // otherwise legitimately hit the same BR-13 block this suite already
    // covers. That's not what this test is checking.
    const create = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-10', allowCreditOverride: true, lines: [{ productId: finishedGood.id, orderedQty: 2, ratePaise: 100 }] });
    expect(create.status).toBe(201);

    const noReason = await request(app).put(`/api/v1/sales/orders/${create.body.data.id}/cancel`).set('Cookie', adminCookie).send({});
    expect(noReason.status).toBe(400);

    const cancelled = await request(app).put(`/api/v1/sales/orders/${create.body.data.id}/cancel`).set('Cookie', adminCookie).send({ reason: 'Customer changed mind' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
  });
});

describe('Production Plan (M08, BR-12)', () => {
  let planId;

  it('proposes a plan covering the open sales order shortfall', async () => {
    const res = await request(app)
      .post('/api/v1/production/plans/generate')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, planDate: '2026-08-11' });
    expect(res.status).toBe(201);

    const line = res.body.data.lines.find((l) => l.productId === finishedGood.id);
    expect(line).toBeTruthy();
    expect(Number(line.requiredQty)).toBe(10); // 10 ordered, 0 in stock
    planId = res.body.data.id;
    productionPlanLineId = line.id;
  });

  it('confirms the plan (human-in-the-loop, BR-12)', async () => {
    const res = await request(app).put(`/api/v1/production/plans/${planId}/confirm`).set('Cookie', adminCookie).send({});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CONFIRMED');
    expect(Number(res.body.data.lines[0].confirmedQty)).toBe(10);
  });
});

describe('Production Entry (M09/M10, BR-06..BR-10)', () => {
  it('casting creates a CURING lot and consumes raw material per the mix design, with zero variance', async () => {
    const res = await request(app)
      .post('/api/v1/production/entries')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id,
        productId: finishedGood.id,
        productionDate: today(),
        goodQty: 10,
        productionPlanLineId,
      });

    expect(res.status).toBe(201);
    expect(res.body.data.lot.status).toBe('CURING'); // curingDays=3, just produced today
    expect(res.body.data.consumptions).toHaveLength(1);
    expect(Number(res.body.data.consumptions[0].mixDesignQty)).toBe(20); // 2 per unit * 10
    expect(Number(res.body.data.consumptions[0].actualQty)).toBe(20);
    expect(Number(res.body.data.consumptions[0].variancePercent)).toBe(0);
    expect(res.body.data.consumptions[0].requiresApproval).toBe(false);

    const rawBalance = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${rawMaterial.id}`).set('Cookie', adminCookie);
    expect(rawBalance.body.data.balance).toBe(180); // 200 - 20
  });

  it('rejects a variance with no reason (BR-09)', async () => {
    const res = await request(app)
      .post('/api/v1/production/entries')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id,
        productId: finishedGood.id,
        productionDate: '2026-08-12',
        goodQty: 5,
        materialLines: [{ rawMaterialProductId: rawMaterial.id, actualQty: 15 }], // expected 10, no reason given
      });
    expect(res.status).toBe(400);
  });

  it('flags a variance beyond the factory threshold for supervisor approval, and allows approving it', async () => {
    const res = await request(app)
      .post('/api/v1/production/entries')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id,
        productId: finishedGood.id,
        productionDate: '2026-08-12',
        goodQty: 5,
        materialLines: [{ rawMaterialProductId: rawMaterial.id, actualQty: 15, varianceReason: 'Extra cement due to humidity' }],
      });
    expect(res.status).toBe(201);
    const consumption = res.body.data.consumptions[0];
    expect(Number(consumption.variancePercent)).toBe(50); // (15-10)/10 * 100
    expect(consumption.requiresApproval).toBe(true);
    expect(consumption.approvedBy).toBeNull();

    const pending = await request(app).get(`/api/v1/production/pending-approvals?factoryId=${factory.id}`).set('Cookie', adminCookie);
    expect(pending.body.data.rows.some((c) => c.id === consumption.id)).toBe(true);

    const approve = await request(app).put(`/api/v1/production/consumptions/${consumption.id}/approve`).set('Cookie', adminCookie);
    expect(approve.status).toBe(200);
    expect(approve.body.data.approvedBy).toBeTruthy();
  });
});

describe('Wastage (M11)', () => {
  it('recording wastage against a lot posts a BREAKAGE_OUT entry and reduces stock', async () => {
    const lots = await request(app).get(`/api/v1/inventory/lots?factoryId=${factory.id}&productId=${rawMaterial.id}`).set('Cookie', adminCookie);
    const lotId = lots.body.data.rows[0].id;

    const before = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${rawMaterial.id}`).set('Cookie', adminCookie);

    const res = await request(app)
      .post('/api/v1/production/wastage')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id,
        productId: rawMaterial.id,
        lotId,
        stage: 'STACKING',
        quantity: 3,
        reason: 'Bag torn during stacking',
        recordedDate: '2026-08-13',
      });
    expect(res.status).toBe(201);

    const after = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${rawMaterial.id}`).set('Cookie', adminCookie);
    expect(after.body.data.balance).toBe(before.body.data.balance - 3);
  });
});
