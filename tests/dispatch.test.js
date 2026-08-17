const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, MixDesign, MixDesignLine, Party,
} = require('../src/models/index');
const { SalesOrderLine } = require('../src/api/sales/salesOrderLine.model');

const PASSWORD = 'password123';
let adminCookie;
let factory;
let rawMaterial;
let finishedGood;
let vendor;
let customer;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const castProduction = async (goodQty, productionDate) => {
  const res = await request(app)
    .post('/api/v1/production/entries')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, productId: finishedGood.id, productionDate, goodQty });
  return res.body.data;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-dispatch', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@dispatch-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  // dispatchTolerancePercent left at the default (0) deliberately, to exercise BR-14's strict case.
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Dispatch Factory', code: 'DISP-FAC' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-DISP' });
  rawMaterial = await Product.create({ tenantId, uomId: uom.id, name: 'Cement Disp', code: 'RM-CEMENT-DISP', productType: 'RAW_MATERIAL', curingDays: 0 });
  // curingDays: 0 so a cast lot is AVAILABLE immediately — dispatch tests don't need to also exercise curing.
  finishedGood = await Product.create({ tenantId, uomId: uom.id, name: 'Precast Slab Disp', code: 'FG-SLAB-DISP', productType: 'FINISHED_GOOD', curingDays: 0 });

  const mixDesign = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mixDesign.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });

  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Disp Vendor' });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Disp Customer' });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@dispatch-test.co', password: PASSWORD }), 'accessToken');

  await request(app)
    .post('/api/v1/purchasing/receipts')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-10', lines: [{ productId: rawMaterial.id, receivedQty: 500, ratePaise: 5000 }] });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Delivery Challan dispatch (M15, BR-01..BR-05, BR-14)', () => {
  let salesOrderId;
  let salesOrderLineId;
  let challanId;

  it('sets up a confirmed order and cast stock, then dispatches it fully', async () => {
    await castProduction(20, '2026-08-15');

    const so = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-15', lines: [{ productId: finishedGood.id, orderedQty: 10, ratePaise: 5000 }] });
    salesOrderId = so.body.data.id;
    salesOrderLineId = so.body.data.lines[0].id;
    await request(app).put(`/api/v1/sales/orders/${salesOrderId}/confirm`).set('Cookie', adminCookie);

    const challan = await request(app)
      .post('/api/v1/dispatch/challans')
      .set('Cookie', adminCookie)
      .send({
        salesOrderId,
        vehicleNumber: 'OD-01-AB-1234',
        driverName: 'Ramesh',
        dispatchDate: '2026-08-16',
        lines: [{ salesOrderLineId, dispatchedQty: 10 }],
      });
    expect(challan.status).toBe(201);
    challanId = challan.body.data.id;

    const updatedLine = await SalesOrderLine.findByPk(salesOrderLineId);
    expect(Number(updatedLine.dispatchedQty)).toBe(10);

    const updatedOrder = await request(app).get(`/api/v1/sales/orders/${salesOrderId}`).set('Cookie', adminCookie);
    expect(updatedOrder.body.data.status).toBe('DISPATCHED'); // fully dispatched (10 of 10)
  });

  it('blocks dispatch beyond ordered quantity + tolerance (BR-14, tolerance=0)', async () => {
    await castProduction(20, '2026-08-15');
    const so = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-16', lines: [{ productId: finishedGood.id, orderedQty: 5, ratePaise: 5000 }] });
    await request(app).put(`/api/v1/sales/orders/${so.body.data.id}/confirm`).set('Cookie', adminCookie);

    const res = await request(app)
      .post('/api/v1/dispatch/challans')
      .set('Cookie', adminCookie)
      .send({
        salesOrderId: so.body.data.id,
        vehicleNumber: 'OD-01-AB-5678',
        dispatchDate: '2026-08-17',
        lines: [{ salesOrderLineId: so.body.data.lines[0].id, dispatchedQty: 6 }],
      });
    expect(res.status).toBe(400);
  });

  it('prints the challan as a PDF (M18) without exposing rates', async () => {
    const res = await request(app).get(`/api/v1/dispatch/challans/${challanId}/print?format=a4`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    expect(res.body.toString('latin1')).not.toMatch(/5000/); // ratePaise never rendered
  });

  it('cancelling a challan reverses stock and the order status (BR-33)', async () => {
    const cancelled = await request(app).put(`/api/v1/dispatch/challans/${challanId}/cancel`).set('Cookie', adminCookie).send({ reason: 'Customer requested reschedule' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const revertedLine = await SalesOrderLine.findByPk(salesOrderLineId);
    expect(Number(revertedLine.dispatchedQty)).toBe(0);

    const revertedOrder = await request(app).get(`/api/v1/sales/orders/${salesOrderId}`).set('Cookie', adminCookie);
    expect(revertedOrder.body.data.status).toBe('CONFIRMED');
  });

  it('BR-16: an order with dispatch history must be short-closed, not cancelled — even after that dispatch is later cancelled', async () => {
    // salesOrderId above still carries dispatch *history* via the (now-cancelled)
    // challan's line, but dispatchedQty is back to 0 — so BR-16's own check
    // (dispatchedQty > 0) no longer blocks a plain cancel. Set up a second,
    // still-active dispatch instead to prove the block.
    await castProduction(20, '2026-08-15');
    const so = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-18', lines: [{ productId: finishedGood.id, orderedQty: 8, ratePaise: 5000 }] });
    await request(app).put(`/api/v1/sales/orders/${so.body.data.id}/confirm`).set('Cookie', adminCookie);

    await request(app)
      .post('/api/v1/dispatch/challans')
      .set('Cookie', adminCookie)
      .send({
        salesOrderId: so.body.data.id,
        vehicleNumber: 'OD-01-AB-9999',
        dispatchDate: '2026-08-19',
        lines: [{ salesOrderLineId: so.body.data.lines[0].id, dispatchedQty: 3 }],
      });

    const cancelAttempt = await request(app).put(`/api/v1/sales/orders/${so.body.data.id}/cancel`).set('Cookie', adminCookie).send({ reason: 'Trying to cancel' });
    expect(cancelAttempt.status).toBe(400);

    const shortClose = await request(app).put(`/api/v1/sales/orders/${so.body.data.id}/short-close`).set('Cookie', adminCookie).send({ reason: 'Remaining qty not needed' });
    expect(shortClose.status).toBe(200);
    expect(shortClose.body.data.status).toBe('SHORT_CLOSED');
  });
});
