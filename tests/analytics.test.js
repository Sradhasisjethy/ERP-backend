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
let oldStockGood;
let vendor;
let customer;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const createInvoice = async (invoiceDate, qty, ratePaise) => {
  await request(app)
    .post('/api/v1/production/entries')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, productId: finishedGood.id, productionDate: invoiceDate, goodQty: qty + 5 });

  const so = await request(app)
    .post('/api/v1/sales/orders')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: invoiceDate, lines: [{ productId: finishedGood.id, orderedQty: qty, ratePaise }] });
  await request(app).put(`/api/v1/sales/orders/${so.body.data.id}/confirm`).set('Cookie', adminCookie);

  const challan = await request(app)
    .post('/api/v1/dispatch/challans')
    .set('Cookie', adminCookie)
    .send({ salesOrderId: so.body.data.id, vehicleNumber: 'OD-01-AN-1', dispatchDate: invoiceDate, lines: [{ salesOrderLineId: so.body.data.lines[0].id, dispatchedQty: qty }] });

  const invoice = await request(app).post('/api/v1/invoices').set('Cookie', adminCookie).send({ challanIds: [challan.body.data.id], invoiceDate });
  return { invoice: invoice.body.data, salesOrder: so.body.data };
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-analytics', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@analytics-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Analytics Factory', code: 'AN-FAC', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-AN' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast', gstRatePercent: 18 });
  rawMaterial = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Cement AN', code: 'RM-CEMENT-AN', productType: 'RAW_MATERIAL', curingDays: 0, standardCostPaise: 5000 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Precast Slab AN', code: 'FG-SLAB-AN', productType: 'FINISHED_GOOD', curingDays: 0, standardCostPaise: 0 });

  const mixDesign = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mixDesign.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 2, uomId: uom.id });

  // A second finished good, produced once in January and never touched again
  // (no sales order/dispatch ever draws against it) — genuinely idle stock,
  // isolated from `finishedGood` so FIFO-by-lot consumption on later August
  // dispatches (which always drains the oldest AVAILABLE lot of a product
  // first) can never reset its last-movement date.
  oldStockGood = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Idle Precast Block AN', code: 'FG-IDLE-AN', productType: 'FINISHED_GOOD', curingDays: 0, standardCostPaise: 0 });
  const idleMix = await MixDesign.create({ tenantId, productId: oldStockGood.id, name: 'Idle Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: idleMix.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });

  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'AN Vendor' });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'AN Customer', state: 'Odisha' });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@analytics-test.co', password: PASSWORD }), 'accessToken');

  await request(app)
    .post('/api/v1/purchasing/receipts')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-01-05', lines: [{ productId: rawMaterial.id, receivedQty: 1000, ratePaise: 5000 }] });

  // Idle stock: produced once in January, never dispatched — this is the lot
  // the stock-ageing/dead-stock test expects to find untouched months later.
  await request(app)
    .post('/api/v1/production/entries')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, productId: oldStockGood.id, productionDate: '2026-01-10', goodQty: 20 });

  // Old invoice (unpaid, > 30 days before "today") for the overdue-receivable alert.
  await createInvoice('2026-01-10', 10, 1000);
  // Recent invoice, within the dashboard's default window.
  await createInvoice('2026-08-05', 6, 1200);
});

afterAll(async () => {
  await sequelize.close();
});

describe('Stock ageing / dead stock (M32)', () => {
  it('buckets AVAILABLE lots by age and flags anything past the dead-stock threshold', async () => {
    const res = await request(app)
      .get(`/api/v1/analytics/stock-ageing?factoryId=${factory.id}&deadStockDays=60`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.buckets).toHaveProperty('90+');
    // The idle lot produced in January and never dispatched should be well past 60 days old by August.
    const oldLot = res.body.data.lots.find((l) => l.productId === oldStockGood.id);
    expect(oldLot).toBeTruthy();
    expect(oldLot.ageDays).toBeGreaterThan(60);
    expect(res.body.data.deadStock.some((l) => l.lotId === oldLot.lotId)).toBe(true);
  });
});

describe('Dashboard KPIs (M33)', () => {
  it('aggregates sales/purchase totals and top products/customers for a period', async () => {
    const res = await request(app)
      .get(`/api/v1/analytics/dashboard?factoryId=${factory.id}&fromDate=2026-08-01&toDate=2026-08-31`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    // 6 * 1200 = 7200 taxable, +18% CGST/SGST (same-state) = 8496, rounded to the nearest rupee = 8500.
    // Only the August invoice falls in range — the January one is excluded by the date filter.
    expect(res.body.data.salesValuePaise).toBe(8500);
    expect(res.body.data.topCustomers[0].customerName).toBe('AN Customer');
    expect(res.body.data.topProducts[0].productName).toBe('Precast Slab AN');
  });
});

describe('Product costing (M34)', () => {
  it('rolls up standard cost from the active mix design and compares it to the realized selling rate', async () => {
    const res = await request(app).get(`/api/v1/analytics/costing?factoryId=${factory.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const row = res.body.data.find((r) => r.productId === finishedGood.id);
    expect(row.standardCostPaise).toBe(10000); // 2 units of cement @ 5000 paise each
    expect(row.avgSellingRatePaise).toBeGreaterThan(0);
    expect(row.marginPaise).toBe(row.avgSellingRatePaise - 10000);
  });
});

describe('Alerts (M37)', () => {
  it('surfaces an overdue-receivable alert for the unpaid January invoice', async () => {
    const res = await request(app).get(`/api/v1/analytics/alerts?factoryId=${factory.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const overdue = res.body.data.find((a) => a.type === 'OVERDUE_RECEIVABLE');
    expect(overdue).toBeTruthy();
    expect(overdue.outstandingPaise).toBeGreaterThan(0);
    expect(overdue.message).not.toMatch(/paise/); // money kept out of prose (BR-27) — asserted structurally, not just by field-nulling
  });
});

describe('Cancellation analytics (M38)', () => {
  it('counts and groups a cancelled sales order by reason', async () => {
    const so = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-09', lines: [{ productId: finishedGood.id, orderedQty: 1, ratePaise: 1000 }] });
    await request(app).put(`/api/v1/sales/orders/${so.body.data.id}/cancel`).set('Cookie', adminCookie).send({ reason: 'Customer changed mind' });

    const res = await request(app)
      .get(`/api/v1/analytics/cancellations?factoryId=${factory.id}&fromDate=2026-08-01&toDate=2026-08-31`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const salesOrders = res.body.data.byDocumentType.find((d) => d.documentType === 'SalesOrder');
    expect(salesOrders.count).toBe(1);
    expect(salesOrders.topReasons[0].reason).toBe('Customer changed mind');
  });
});

describe('Document search (M39)', () => {
  it('finds a sales invoice by a partial invoice number match', async () => {
    const invoices = await request(app).get(`/api/v1/invoices?factoryId=${factory.id}`).set('Cookie', adminCookie);
    const invoiceNumber = invoices.body.data.rows[0].invoiceNumber;
    const fragment = invoiceNumber.slice(0, 4);

    const res = await request(app).get(`/api/v1/analytics/search?q=${fragment}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.some((r) => r.documentType === 'SalesInvoice' && r.number === invoiceNumber)).toBe(true);
  });

  it('rejects a query shorter than 2 characters', async () => {
    const res = await request(app).get('/api/v1/analytics/search?q=a').set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });
});
