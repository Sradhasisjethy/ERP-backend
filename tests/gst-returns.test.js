const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, MixDesign, MixDesignLine, Party,
} = require('../src/models/index');

/**
 * GST rate summary and GSTR-9 working papers.
 *
 *   purchase  1,000 bags cement @ ₹5, HSN 2523 at 28%, from an Odisha vendor
 *             → ITC ₹1,400 split CGST ₹700 / SGST ₹700
 *   sale      10 pavers @ ₹500, HSN 6810 at 18%, to a walk-in (B2C), in May
 *             → taxable ₹500, GST ₹90
 */

const PASSWORD = 'password123';
let cookie;
let factory;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const get = (url, query) => request(app).get(url).set('Cookie', cookie).query(query);
const post = (url, body) => request(app).post(url).set('Cookie', cookie).send(body);

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'GST Precast', slug: 'gst-precast', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'GST Precast Pvt Ltd', code: 'GPL' });
  await User.create(
    { tenantId, email: 'admin@gst.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'GST Plant', code: 'GST', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-GST' });
  const hsnPaver = await HsnCode.create({ tenantId, code: '6810', description: 'Precast concrete', gstRatePercent: 18 });
  const hsnCement = await HsnCode.create({ tenantId, code: '2523', description: 'Cement', gstRatePercent: 28 });
  const cement = await Product.create({ tenantId, uomId: uom.id, hsnId: hsnCement.id, name: 'Cement Gst', code: 'RM-CEM-GST', productType: 'RAW_MATERIAL', curingDays: 0 });
  const paver = await Product.create({ tenantId, uomId: uom.id, hsnId: hsnPaver.id, name: 'Paver Gst', code: 'FG-PAV-GST', productType: 'FINISHED_GOOD', curingDays: 0 });
  const mix = await MixDesign.create({ tenantId, productId: paver.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: cement.id, quantityPerUnit: 1, uomId: uom.id });
  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Gst Cement Co', state: 'Odisha' });

  cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@gst.co', password: PASSWORD }), 'accessToken');

  const grn = await post('/api/v1/purchasing/receipts', {
    factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-04-10',
    lines: [{ productId: cement.id, receivedQty: 1000, ratePaise: 500 }],
  });
  expect(grn.status).toBe(201);
  expect((await post('/api/v1/purchasing/invoices', {
    factoryId: factory.id, goodsReceiptId: grn.body.data.id, vendorPartyId: vendor.id,
    vendorInvoiceNumber: 'GST/001', invoiceDate: '2026-04-10', dueDate: '2026-05-10', amountPaise: 640000,
  })).status).toBe(201);
  expect((await post('/api/v1/production/entries', { factoryId: factory.id, productId: paver.id, productionDate: '2026-04-20', goodQty: 50 })).status).toBe(201);
  expect((await post('/api/v1/retail/counter-sales', {
    factoryId: factory.id, invoiceDate: '2026-05-05',
    customer: { name: 'Walk-in Gst', phone: '9811100001' },
    lines: [{ productId: paver.id, quantity: 10, ratePaise: 5000 }],
    payment: { modes: [{ mode: 'CASH', amountPaise: 59000 }] },
  })).status).toBe(201);
});

afterAll(async () => {
  await sequelize.close();
});

describe('GST rate summary', () => {
  it('puts sales and purchases under their own rates', async () => {
    const res = await get('/api/v1/gstr/tax-rate-summary', { factoryId: factory.id, fromDate: '2026-04-01', toDate: '2026-06-30' });
    expect(res.status).toBe(200);
    const byRate = Object.fromEntries(res.body.data.rows.map((r) => [r.gstRatePercent, r]));

    expect(byRate[18].outward).toMatchObject({ taxableValuePaise: 50000, cgstPaise: 4500, sgstPaise: 4500, igstPaise: 0, totalTaxPaise: 9000 });
    expect(byRate[18].inward.taxableValuePaise).toBe(0);
    expect(byRate[28].inward).toMatchObject({ taxableValuePaise: 500000, cgstPaise: 70000, sgstPaise: 70000, totalTaxPaise: 140000 });
    expect(res.body.data.totals.outward.totalTaxPaise).toBe(9000);
    expect(res.body.data.totals.inward.totalTaxPaise).toBe(140000);
  });

  it('agrees with GSTR-3B for the same period', async () => {
    const q = { factoryId: factory.id, fromDate: '2026-04-01', toDate: '2026-06-30' };
    const summary = (await get('/api/v1/gstr/tax-rate-summary', q)).body.data;
    const g3b = (await get('/api/v1/gstr/gstr3b', q)).body.data;
    const tax = (x) => x.cgstPaise + x.sgstPaise + x.igstPaise;
    expect(summary.totals.outward.totalTaxPaise).toBe(tax(g3b.outwardSupplies));
    expect(summary.totals.inward.totalTaxPaise).toBe(tax(g3b.itcAvailable));
  });
});

describe('GSTR-9 working papers', () => {
  let g9;

  beforeAll(async () => {
    const res = await get('/api/v1/gstr/gstr9', { factoryId: factory.id, fromDate: '2026-04-01', toDate: '2027-03-31' });
    expect(res.status).toBe(200);
    g9 = res.body.data;
  });

  it('reports the year’s outward supplies, split B2B / B2C', () => {
    expect(g9.table4.b2c.taxableValuePaise).toBe(50000);
    expect(g9.table4.b2b.taxableValuePaise).toBe(0);
    expect(g9.table4.total.taxableValuePaise).toBe(50000);
  });

  it('reports ITC and the net tax per books', () => {
    expect(g9.table6.itcAvailed.cgstPaise).toBe(70000);
    // ITC exceeds output tax, so nothing is payable — never a negative payable.
    expect(g9.table9.netPayable).toEqual({ cgstPaise: 0, sgstPaise: 0, igstPaise: 0 });
  });

  it('carries the HSN summary', () => {
    expect(g9.table17.hsnSummary).toEqual([expect.objectContaining({ hsnCode: '6810', taxableValuePaise: 50000, totalQuantity: 10 })]);
  });

  it('breaks the year into months that add back to the annual figure', () => {
    expect(g9.months).toHaveLength(12);
    expect(g9.months[0].month).toBe('2026-04');
    expect(g9.months.find((m) => m.month === '2026-05').outwardTaxablePaise).toBe(50000);
    expect(g9.months.reduce((s, m) => s + m.outwardTaxablePaise, 0)).toBe(g9.table4.total.taxableValuePaise);
    expect(g9.months.find((m) => m.month === '2026-04').itcPaise).toBe(140000);
  });
});
