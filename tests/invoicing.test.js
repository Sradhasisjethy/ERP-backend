const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, MixDesign, MixDesignLine, Party,
} = require('../src/models/index');
const { DeliveryChallan } = require('../src/api/dispatch/deliveryChallan.model');

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

const castAndConfirmOrder = async (orderedQty, ratePaise) => {
  await request(app)
    .post('/api/v1/production/entries')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, productId: finishedGood.id, productionDate: '2026-08-15', goodQty: orderedQty + 5 });

  const so = await request(app)
    .post('/api/v1/sales/orders')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-15', lines: [{ productId: finishedGood.id, orderedQty, ratePaise }] });
  await request(app).put(`/api/v1/sales/orders/${so.body.data.id}/confirm`).set('Cookie', adminCookie);
  return so.body.data;
};

const dispatch = async (salesOrderId, salesOrderLineId, qty, vehicle) => {
  const res = await request(app)
    .post('/api/v1/dispatch/challans')
    .set('Cookie', adminCookie)
    .send({ salesOrderId, vehicleNumber: vehicle, dispatchDate: '2026-08-16', lines: [{ salesOrderLineId, dispatchedQty: qty }] });
  return res.body.data;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-invoicing', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@invoicing-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  // Factory and customer both in Odisha => intra-state (CGST+SGST).
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Invoicing Factory', code: 'INV-FAC', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-INV' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast concrete', gstRatePercent: 18 });
  rawMaterial = await Product.create({ tenantId, uomId: uom.id, name: 'Cement Inv', code: 'RM-CEMENT-INV2', productType: 'RAW_MATERIAL', curingDays: 0 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Precast Slab Inv', code: 'FG-SLAB-INV2', productType: 'FINISHED_GOOD', curingDays: 0 });

  const mixDesign = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mixDesign.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });

  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Inv Vendor' });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Inv Customer', state: 'Odisha' });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@invoicing-test.co', password: PASSWORD }), 'accessToken');

  await request(app)
    .post('/api/v1/purchasing/receipts')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-10', lines: [{ productId: rawMaterial.id, receivedQty: 500, ratePaise: 5000 }] });
});

afterAll(async () => {
  await sequelize.close();
});

describe('GST Sales Invoicing (M20/M21, BR-15, BR-18)', () => {
  it('creates an intra-state invoice from a single challan with CGST+SGST split', async () => {
    const so = await castAndConfirmOrder(10, 100000); // Rs 1000/unit
    const challan = await dispatch(so.id, so.lines[0].id, 10, 'OD-01-INV-1');

    const res = await request(app)
      .post('/api/v1/invoices')
      .set('Cookie', adminCookie)
      .send({ challanIds: [challan.id], invoiceDate: '2026-08-17' });

    expect(res.status).toBe(201);
    const invoice = res.body.data;
    expect(Number(invoice.subtotalPaise)).toBe(1000000); // 10 * 100000
    expect(Number(invoice.cgstPaise)).toBe(90000); // 9%
    expect(Number(invoice.sgstPaise)).toBe(90000); // 9%
    expect(Number(invoice.igstPaise)).toBe(0);
    expect(Number(invoice.totalPaise)).toBe(1180000);

    const updatedChallan = await DeliveryChallan.findByPk(challan.id);
    expect(updatedChallan.invoiced).toBe(true);
  });

  it('blocks invoicing the same challan twice (BR-15)', async () => {
    const so = await castAndConfirmOrder(5, 50000);
    const challan = await dispatch(so.id, so.lines[0].id, 5, 'OD-01-INV-2');

    const first = await request(app).post('/api/v1/invoices').set('Cookie', adminCookie).send({ challanIds: [challan.id], invoiceDate: '2026-08-17' });
    expect(first.status).toBe(201);

    const second = await request(app).post('/api/v1/invoices').set('Cookie', adminCookie).send({ challanIds: [challan.id], invoiceDate: '2026-08-17' });
    expect(second.status).toBe(400);
  });

  it('consolidates multiple challans from the same order into one invoice', async () => {
    const so = await castAndConfirmOrder(20, 100000);
    const challan1 = await dispatch(so.id, so.lines[0].id, 8, 'OD-01-INV-3A');
    const challan2 = await dispatch(so.id, so.lines[0].id, 12, 'OD-01-INV-3B');

    const res = await request(app)
      .post('/api/v1/invoices')
      .set('Cookie', adminCookie)
      .send({ challanIds: [challan1.id, challan2.id], invoiceDate: '2026-08-18' });

    expect(res.status).toBe(201);
    expect(res.body.data.lines).toHaveLength(2);
    expect(Number(res.body.data.subtotalPaise)).toBe(2000000); // 20 * 100000
  });

  it('cancelling an invoice reverses the ledger and un-invoices its challans', async () => {
    const so = await castAndConfirmOrder(3, 100000);
    const challan = await dispatch(so.id, so.lines[0].id, 3, 'OD-01-INV-4');

    const invoiceRes = await request(app).post('/api/v1/invoices').set('Cookie', adminCookie).send({ challanIds: [challan.id], invoiceDate: '2026-08-19' });
    const invoiceId = invoiceRes.body.data.id;

    const outstandingBefore = await request(app).get(`/api/v1/ledger/party/${customer.id}`).set('Cookie', adminCookie);

    const cancelled = await request(app).put(`/api/v1/invoices/${invoiceId}/cancel`).set('Cookie', adminCookie).send({ reason: 'Wrong customer billed' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const revertedChallan = await DeliveryChallan.findByPk(challan.id);
    expect(revertedChallan.invoiced).toBe(false);

    const outstandingAfter = await request(app).get(`/api/v1/ledger/party/${customer.id}`).set('Cookie', adminCookie);
    expect(outstandingAfter.body.data.outstandingPaise).toBeLessThan(outstandingBefore.body.data.outstandingPaise);
  });
});
