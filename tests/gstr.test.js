const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, MixDesign, MixDesignLine, Party,
} = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;
let factory;
let rawMaterial;
let finishedGood;
let vendor;
let customerSameState;
let customerOtherState;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const createInvoice = async (customer, qty, ratePaise) => {
  await request(app)
    .post('/api/v1/production/entries')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, productId: finishedGood.id, productionDate: '2026-08-15', goodQty: qty + 5 });

  const so = await request(app)
    .post('/api/v1/sales/orders')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-15', lines: [{ productId: finishedGood.id, orderedQty: qty, ratePaise }] });
  await request(app).put(`/api/v1/sales/orders/${so.body.data.id}/confirm`).set('Cookie', adminCookie);

  const challan = await request(app)
    .post('/api/v1/dispatch/challans')
    .set('Cookie', adminCookie)
    .send({ salesOrderId: so.body.data.id, vehicleNumber: 'OD-01-GSTR-1', dispatchDate: '2026-08-16', lines: [{ salesOrderLineId: so.body.data.lines[0].id, dispatchedQty: qty }] });

  const invoice = await request(app).post('/api/v1/invoices').set('Cookie', adminCookie).send({ challanIds: [challan.body.data.id], invoiceDate: '2026-08-17' });
  return invoice.body.data;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-gstr', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@gstr-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'GSTR Factory', code: 'GSTR-FAC', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-GSTR' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast', gstRatePercent: 18 });
  rawMaterial = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Cement GSTR', code: 'RM-CEMENT-GSTR', productType: 'RAW_MATERIAL', curingDays: 0 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Precast Slab GSTR', code: 'FG-SLAB-GSTR', productType: 'FINISHED_GOOD', curingDays: 0 });

  const mixDesign = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mixDesign.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 2, uomId: uom.id });

  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'GSTR Vendor', gstin: '21AAAAA0000A1Z5', state: 'Odisha' });
  customerSameState = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Same State Customer', gstin: '21BBBBB0000B1Z5', state: 'Odisha' });
  customerOtherState = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Other State Customer', state: 'West Bengal' });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@gstr-test.co', password: PASSWORD }), 'accessToken');

  // Fund raw material stock so production entries can run.
  await request(app)
    .post('/api/v1/purchasing/receipts')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-10', lines: [{ productId: rawMaterial.id, receivedQty: 500, ratePaise: 5000 }] });
});

afterAll(async () => {
  await sequelize.close();
});

describe('GSTR-1 export (M31)', () => {
  it('splits invoices into B2B (same-state, CGST+SGST) and B2C (no GSTIN), and builds an HSN summary', async () => {
    await createInvoice(customerSameState, 10, 1000); // 21AAAAA... has a GSTIN and is same-state -> CGST+SGST, B2B
    await createInvoice(customerOtherState, 5, 1000); // no GSTIN -> B2C; also inter-state -> IGST

    const res = await request(app)
      .get(`/api/v1/gstr/gstr1?factoryId=${factory.id}&fromDate=2026-08-01&toDate=2026-08-31`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);

    expect(res.body.data.b2b).toHaveLength(1);
    expect(res.body.data.b2b[0].cgstPaise).toBeGreaterThan(0);
    expect(res.body.data.b2b[0].sgstPaise).toBeGreaterThan(0);
    expect(res.body.data.b2b[0].igstPaise).toBe(0);

    expect(res.body.data.b2c).toHaveLength(1);
    expect(res.body.data.b2c[0].igstPaise).toBeGreaterThan(0);
    expect(res.body.data.b2c[0].cgstPaise).toBe(0);

    expect(res.body.data.hsnSummary).toHaveLength(1);
    expect(res.body.data.hsnSummary[0].hsnCode).toBe('6810');
    expect(res.body.data.hsnSummary[0].totalQuantity).toBe(15); // 10 + 5

    expect(res.body.data.summary.taxableValuePaise).toBe(15000); // 15 * 1000
  });

  it('rejects a request missing the required date range', async () => {
    const res = await request(app).get(`/api/v1/gstr/gstr1?factoryId=${factory.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });
});

describe('GSTR-3B export (M31)', () => {
  it('computes outward liability from sales invoices and ITC from purchase invoices in the period', async () => {
    const receipt = await request(app)
      .post('/api/v1/purchasing/receipts')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-12', lines: [{ productId: rawMaterial.id, receivedQty: 100, ratePaise: 5000 }] });

    await request(app)
      .post('/api/v1/purchasing/invoices')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id, goodsReceiptId: receipt.body.data.id, vendorPartyId: vendor.id,
        vendorInvoiceNumber: 'VINV-GSTR-1', invoiceDate: '2026-08-12', amountPaise: 590000,
      });

    const res = await request(app)
      .get(`/api/v1/gstr/gstr3b?factoryId=${factory.id}&fromDate=2026-08-01&toDate=2026-08-31`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);

    // Outward: 15 units * 1000 taxable, split across a same-state (CGST+SGST) and inter-state (IGST) invoice.
    expect(res.body.data.outwardSupplies.taxableValuePaise).toBe(15000);
    expect(res.body.data.outwardSupplies.cgstPaise + res.body.data.outwardSupplies.sgstPaise + res.body.data.outwardSupplies.igstPaise).toBeGreaterThan(0);

    // ITC: 100 * 5000 = 500000 taxable @ 18% same-state -> CGST+SGST split.
    expect(res.body.data.itcAvailable.taxableValuePaise).toBe(500000);
    expect(res.body.data.itcAvailable.cgstPaise).toBe(45000);
    expect(res.body.data.itcAvailable.sgstPaise).toBe(45000);
    expect(res.body.data.itcAvailable.igstPaise).toBe(0);
  });
});
