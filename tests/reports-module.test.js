const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, ProductCategory, HsnCode, Party,
  MixDesign, MixDesignLine, AdGroup, AdGroupMember, UserFactory, DocumentSeries,
} = require('../src/models/index');
const { allReports, CATEGORIES } = require('../src/api/reports/definitions');

/**
 * Reports module (catalog-driven).
 *
 * The properties worth testing here are the ones a report engine gets wrong
 * silently: a summary that totals only the visible page, a sort that lets the
 * client name a column, a page-2 that repeats a row from page 1, an export that
 * ships a column the screen withheld, and a location filter that a user can
 * step outside of. Each of those has a test below rather than a comment.
 */

const PASSWORD = 'password123';
const API = '/api/v1/reports';

let adminCookie;      // PLATFORM_ADMIN — bypasses permission and factory scope
let managerCookie;    // scoped to factory A, full report grants, can see rates
let clerkCookie;      // sales reports only, no export, no VIEW_RATES
let otherTenantCookie;

let factoryA;
let factoryB;
let customer;
let otherCustomer;
let finishedGood;
let category;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const login = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

/**
 * Every step is asserted. A fixture that half-succeeds produces reports with no
 * rows, and every assertion downstream then fails for a reason that has nothing
 * to do with what it was testing — so a broken fixture must fail loudly, here,
 * naming the step that broke.
 */
const expectStep = (step, response, expected = 201) => {
  if (response.status !== expected) {
    throw new Error(`Fixture step "${step}" returned ${response.status}: ${response.body?.message || 'no message'}`);
  }
  return response.body.data;
};

/**
 * Receives raw material. Production consumes against the BOM, and the factory
 * does not allow negative stock, so this has to happen before anything is made.
 * It also gives the purchase reports real documents to report on.
 */
const receiveMaterial = async ({ cookie, factory, vendorId, productId, qty, ratePaise, date }) =>
  expectStep(
    'goods receipt',
    await request(app)
      .post('/api/v1/purchasing/receipts')
      .set('Cookie', cookie)
      .send({ factoryId: factory.id, vendorPartyId: vendorId, receiptDate: date, lines: [{ productId, receivedQty: qty, ratePaise }] })
  );

/** Produces stock, raises an order, dispatches it and invoices it. */
const sellSomething = async ({ cookie, factory, customerId, productId, qty, ratePaise, date }) => {
  // Produce more than the order needs, so the dispatch is never short.
  expectStep(
    'production entry',
    await request(app)
      .post('/api/v1/production/entries')
      .set('Cookie', cookie)
      .send({ factoryId: factory.id, productId, productionDate: date, goodQty: qty + 5 })
  );

  const order = expectStep(
    'sales order',
    await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', cookie)
      .send({
        factoryId: factory.id,
        customerPartyId: customerId,
        orderDate: date,
        expectedDeliveryDate: date,
        lines: [{ productId, orderedQty: qty, ratePaise }],
      })
  );
  expectStep('confirm order', await request(app).put(`/api/v1/sales/orders/${order.id}/confirm`).set('Cookie', cookie), 200);

  const challan = expectStep(
    'delivery challan',
    await request(app)
      .post('/api/v1/dispatch/challans')
      .set('Cookie', cookie)
      .send({
        salesOrderId: order.id,
        vehicleNumber: 'OD-02-AB-1234',
        dispatchDate: date,
        lines: [{ salesOrderLineId: order.lines[0].id, dispatchedQty: qty }],
      })
  );

  const invoice = expectStep(
    'sales invoice',
    await request(app).post('/api/v1/invoices').set('Cookie', cookie).send({ challanIds: [challan.id], invoiceDate: date })
  );

  return { order, challan, invoice };
};

/**
 * Gives a factory its own document-number prefixes.
 *
 * Document numbers are `<prefix>/<sequence>` with no factory component, and the
 * sequence restarts per factory — so a tenant's second factory would generate
 * `GRN/0001` again and collide with the first factory's, which the tenant-wide
 * unique index rejects. Configuring a distinct prefix per factory is how the
 * system is meant to be set up for a multi-factory tenant (document_series.prefix
 * exists for exactly this), and it is what the fixture does here.
 */
const NUMBERED_DOCUMENTS = [
  'GOODS_RECEIPT', 'PRODUCTION_ENTRY', 'SALES_ORDER', 'DELIVERY_CHALLAN', 'SALES_INVOICE',
  'RECEIPT', 'PAYMENT', 'EXPENSE', 'PURCHASE_ORDER', 'STOCK_TRANSFER',
];

const configureNumbering = async ({ tenantId, factoryId, financialYearId, suffix }) => {
  for (const documentType of NUMBERED_DOCUMENTS) {
    await DocumentSeries.create({
      tenantId,
      documentType,
      factoryId,
      financialYearId,
      prefix: `${documentType.split('_').map((w) => w[0]).join('')}${suffix}`,
      nextSequence: 1,
      padding: 4,
    });
  }
};

const seedTenant = async ({ slug, orgName, factoryCode, emailDomain }) => {
  const tenant = await Tenant.create({ name: orgName, slug, status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: orgName, code: factoryCode });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, organizationId: org.id, email: `admin@${emailDomain}`, passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  const financialYear = await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const factory = await Factory.create({ tenantId, organizationId: org.id, name: `${orgName} Works`, code: factoryCode, state: 'Odisha' });
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: `NOS-${factoryCode}` });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast', gstRatePercent: 18 });
  const cat = await ProductCategory.create({ tenantId, name: 'Slabs', code: `SLB-${factoryCode}` });
  const rawMaterial = await Product.create({
    tenantId, uomId: uom.id, hsnId: hsn.id, categoryId: cat.id,
    name: 'Cement', code: `RM-${factoryCode}`, productType: 'RAW_MATERIAL', curingDays: 0, standardCostPaise: 5000,
  });
  const product = await Product.create({
    tenantId, uomId: uom.id, hsnId: hsn.id, categoryId: cat.id,
    name: 'Precast Slab', code: `FG-${factoryCode}`, productType: 'FINISHED_GOOD', curingDays: 0, standardCostPaise: 1000,
  });

  // Production will not post without an active BOM for the product, and
  // dispatch will not post without the stock that production creates — so the
  // mix design is part of the fixture, not an optional extra.
  const mixDesign = await MixDesign.create({ tenantId, productId: product.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mixDesign.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });

  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: `${orgName} Supplier`, code: `VEN-${factoryCode}`, state: 'Odisha' });
  const buyer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: `${orgName} Buyer`, code: `CUS-${factoryCode}`, state: 'Odisha', creditAgeingDays: 30 });
  await configureNumbering({ tenantId, factoryId: factory.id, financialYearId: financialYear.id, suffix: `-${factoryCode}` });

  return { tenant, tenantId, org, factory, financialYear, uom, hsn, cat, product, rawMaterial, vendor, buyer };
};

beforeAll(async () => {
  await resetDatabase();

  // --- Tenant 1: the tenant under test ---
  const main = await seedTenant({ slug: 'rpt-main', orgName: 'Bhuasuni Precast', factoryCode: 'RPTA', emailDomain: 'rpt-main.co' });
  const { tenantId, org } = main;
  factoryA = main.factory;
  customer = main.buyer;
  finishedGood = main.product;
  category = main.cat;

  factoryB = await Factory.create({ tenantId, organizationId: org.id, name: 'Second Works', code: 'RPTB', state: 'Odisha' });
  await configureNumbering({ tenantId, factoryId: factoryB.id, financialYearId: main.financialYear.id, suffix: '-RPTB' });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  // A manager who may read and export every report category, may see rates,
  // and is assigned to factory A only.
  const manager = await User.create(
    { tenantId, organizationId: org.id, email: 'manager@rpt-main.co', passwordHash, firstName: 'Meera', lastName: 'Nayak', role: 'EMPLOYEE' },
    { validate: false }
  );
  const managerGroup = await AdGroup.create({
    tenantId,
    name: 'Report Managers',
    permissions: [
      ...CATEGORIES.map((c) => `${c.permissionKey}_READ`),
      ...CATEGORIES.map((c) => `${c.permissionKey}_EXPORT`),
      'VIEW_RATES',
    ],
  });
  await AdGroupMember.create({ tenantId, adGroupId: managerGroup.id, employeeId: manager.id });
  await UserFactory.create({ tenantId, userId: manager.id, factoryId: factoryA.id });

  // A clerk who may read sales reports and nothing else: no export grant, no
  // VIEW_RATES, no factory assignment.
  const clerk = await User.create(
    { tenantId, organizationId: org.id, email: 'clerk@rpt-main.co', passwordHash, firstName: 'Raj', lastName: 'Das', role: 'EMPLOYEE' },
    { validate: false }
  );
  const clerkGroup = await AdGroup.create({ tenantId, name: 'Sales Report Viewers', permissions: ['REPORT_SALES_READ'] });
  await AdGroupMember.create({ tenantId, adGroupId: clerkGroup.id, employeeId: clerk.id });
  // Assigned to both factories on purpose: these tests are about field-level
  // security, and a user who can see no rows would pass them vacuously.
  await UserFactory.create({ tenantId, userId: clerk.id, factoryId: factoryA.id });
  await UserFactory.create({ tenantId, userId: clerk.id, factoryId: factoryB.id });

  adminCookie = await login('admin@rpt-main.co');
  managerCookie = await login('manager@rpt-main.co');
  clerkCookie = await login('clerk@rpt-main.co');

  // --- Business activity in factory A, on three separate days ---
  // Raw material first: production consumes against the BOM and the factory
  // does not allow negative stock.
  await receiveMaterial({ cookie: adminCookie, factory: factoryA, vendorId: main.vendor.id, productId: main.rawMaterial.id, qty: 500, ratePaise: 5000, date: '2026-08-01' });
  await receiveMaterial({ cookie: adminCookie, factory: factoryB, vendorId: main.vendor.id, productId: main.rawMaterial.id, qty: 200, ratePaise: 5000, date: '2026-08-01' });

  await sellSomething({ cookie: adminCookie, factory: factoryA, customerId: customer.id, productId: finishedGood.id, qty: 10, ratePaise: 100000, date: '2026-08-05' });
  await sellSomething({ cookie: adminCookie, factory: factoryA, customerId: customer.id, productId: finishedGood.id, qty: 20, ratePaise: 100000, date: '2026-08-10' });

  otherCustomer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Zeta Constructions', code: 'CUS-ZETA', state: 'Odisha', creditAgeingDays: 15 });
  await sellSomething({ cookie: adminCookie, factory: factoryA, customerId: otherCustomer.id, productId: finishedGood.id, qty: 5, ratePaise: 200000, date: '2026-08-20' });

  // One invoice in factory B, which the manager must never see.
  await sellSomething({ cookie: adminCookie, factory: factoryB, customerId: customer.id, productId: finishedGood.id, qty: 7, ratePaise: 100000, date: '2026-08-12' });

  await request(app)
    .post('/api/v1/expenses')
    .set('Cookie', adminCookie)
    .send({ factoryId: factoryA.id, expenseDate: '2026-08-06', category: 'Diesel', mode: 'CASH', amountPaise: 250000 });

  // --- Tenant 2: exists only to prove it is invisible from tenant 1 ---
  const other = await seedTenant({ slug: 'rpt-other', orgName: 'Rival Concretes', factoryCode: 'OTH', emailDomain: 'rpt-other.co' });
  otherTenantCookie = await login('admin@rpt-other.co');
  await receiveMaterial({
    cookie: otherTenantCookie, factory: other.factory, vendorId: other.vendor.id,
    productId: other.rawMaterial.id, qty: 500, ratePaise: 5000, date: '2026-08-01',
  });
  await sellSomething({
    cookie: otherTenantCookie, factory: other.factory, customerId: other.buyer.id,
    productId: other.product.id, qty: 99, ratePaise: 999999, date: '2026-08-08',
  });
});

afterAll(async () => {
  await sequelize.close();
});

const getReport = (path, cookie, query = {}) =>
  request(app).get(`${API}/${path}`).set('Cookie', cookie).query(query);

describe('Report catalog', () => {
  it('requires authentication', async () => {
    expect((await request(app).get(`${API}/catalog`)).status).toBe(401);
    expect((await request(app).get(`${API}/sales/summary`)).status).toBe(401);
  });

  it('serves every category to a fully-granted user', async () => {
    const res = await getReport('catalog'.replace('catalog', 'catalog'), managerCookie);
    const catalog = await request(app).get(`${API}/catalog`).set('Cookie', managerCookie);
    expect(catalog.status).toBe(200);
    expect(catalog.body.data.categories).toHaveLength(CATEGORIES.length);
    const total = catalog.body.data.categories.reduce((sum, c) => sum + c.reports.length, 0);
    expect(total).toBe(allReports().length);
    expect(res.status).toBe(200);
  });

  it('hides categories the user holds no grant for', async () => {
    const res = await request(app).get(`${API}/catalog`).set('Cookie', clerkCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.categories.map((c) => c.id)).toEqual(['sales']);
    // Read-only grant: the clerk sees the reports but cannot download them.
    expect(res.body.data.categories[0].reports.every((r) => r.canExport === false)).toBe(true);
  });

  it('404s an unknown report rather than leaking that the route exists', async () => {
    expect((await getReport('sales/not-a-report', adminCookie)).status).toBe(404);
    expect((await getReport('not-a-category/summary', adminCookie)).status).toBe(404);
  });

  it('refuses a report the user has no view grant for', async () => {
    expect((await getReport('finance/day-book', clerkCookie)).status).toBe(403);
    expect((await getReport('sales/summary', clerkCookie)).status).toBe(200);
  });
});

describe('Report data contract', () => {
  it('returns rows, a page envelope and the report definition', async () => {
    const res = await getReport('sales/summary', adminCookie);
    expect(res.status).toBe(200);

    const { rows, count, page, limit, totalPages, columns, summary, report } = res.body.data;
    expect(Array.isArray(rows)).toBe(true);
    expect(count).toBe(4); // three invoices in factory A, one in factory B
    expect(page).toBe(1);
    expect(limit).toBe(25);
    expect(totalPages).toBe(1);
    expect(columns.some((c) => c.key === 'invoiceNumber')).toBe(true);
    expect(summary.invoiceCount).toBe(4);
    expect(report.id).toBe('sales-summary');
  });

  it('rejects query parameters outside the report vocabulary', async () => {
    expect((await getReport('sales/summary', adminCookie, { dropTable: '1' })).status).toBe(400);
    expect((await getReport('sales/summary', adminCookie, { dateFrom: '05-08-2026' })).status).toBe(400);
    expect((await getReport('sales/summary', adminCookie, { factoryId: 'not-a-uuid' })).status).toBe(400);
    expect((await getReport('sales/summary', adminCookie, { limit: '5000' })).status).toBe(400);
  });

  it('rejects a backwards date range instead of silently returning nothing', async () => {
    const res = await getReport('sales/summary', adminCookie, { dateFrom: '2026-08-31', dateTo: '2026-08-01' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/on or before/i);
  });

  it('treats the date range as inclusive of both end dates', async () => {
    // The 05-Aug invoice must be inside a range that starts and ends on 05-Aug.
    const res = await getReport('sales/summary', adminCookie, { dateFrom: '2026-08-05', dateTo: '2026-08-05' });
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.rows[0].invoiceDate).toBe('2026-08-05');
  });
});

describe('Summary totals', () => {
  it('totals the whole filtered set, not the visible page', async () => {
    const full = await getReport('sales/summary', adminCookie, { limit: 100 });
    const paged = await getReport('sales/summary', adminCookie, { limit: 1 });

    const netFromAllRows = full.body.data.rows.reduce((sum, r) => sum + r.netPaise, 0);
    expect(paged.body.data.rows).toHaveLength(1);
    expect(paged.body.data.summary.netPaise).toBe(netFromAllRows);
    expect(paged.body.data.summary.netPaise).toBeGreaterThan(paged.body.data.rows[0].netPaise);
  });

  it('moves with the filters', async () => {
    const all = await getReport('sales/summary', adminCookie);
    const oneCustomer = await getReport('sales/summary', adminCookie, { customerId: otherCustomer.id });
    expect(oneCustomer.body.data.summary.invoiceCount).toBe(1);
    expect(oneCustomer.body.data.summary.netPaise).toBeLessThan(all.body.data.summary.netPaise);
  });

  it('agrees with the transactional data it is derived from', async () => {
    // Sales Summary and Sales Detail read the same invoices from different
    // angles; their net totals must match to the paisa.
    const summary = await getReport('sales/summary', adminCookie, { limit: 100 });
    const detail = await getReport('sales/detail', adminCookie, { limit: 100 });
    const detailTotal = detail.body.data.rows.reduce((sum, r) => sum + r.lineTotalPaise, 0);
    const summaryTaxable = summary.body.data.summary.grossPaise + summary.body.data.summary.taxPaise;
    expect(detailTotal).toBe(summaryTaxable);
  });
});

describe('Pagination', () => {
  it('splits the result set without repeating or dropping a row', async () => {
    const page1 = await getReport('sales/summary', adminCookie, { limit: 2, page: 1 });
    const page2 = await getReport('sales/summary', adminCookie, { limit: 2, page: 2 });

    expect(page1.body.data.totalPages).toBe(2);
    expect(page1.body.data.count).toBe(4);
    expect(page1.body.data.rows).toHaveLength(2);
    expect(page2.body.data.rows).toHaveLength(2);

    const ids = [...page1.body.data.rows, ...page2.body.data.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(4);
  });

  it('returns an empty page rather than an error past the end', async () => {
    const res = await getReport('sales/summary', adminCookie, { limit: 2, page: 99 });
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(0);
    expect(res.body.data.count).toBe(4);
  });
});

describe('Sorting', () => {
  it('sorts on an allow-listed column in both directions', async () => {
    const asc = await getReport('sales/summary', adminCookie, { sortBy: 'netPaise', sortDir: 'asc', limit: 100 });
    const desc = await getReport('sales/summary', adminCookie, { sortBy: 'netPaise', sortDir: 'desc', limit: 100 });

    const ascValues = asc.body.data.rows.map((r) => r.netPaise);
    expect([...ascValues].sort((a, b) => a - b)).toEqual(ascValues);
    expect(desc.body.data.rows.map((r) => r.netPaise)).toEqual([...ascValues].reverse());
    expect(asc.body.data.sort).toEqual({ by: 'netPaise', dir: 'asc' });
  });

  it('ignores a column the report never published instead of passing it to SQL', async () => {
    const res = await getReport('sales/summary', adminCookie, { sortBy: 'passwordHash', sortDir: 'asc' });
    expect(res.status).toBe(200);
    // Fell back to the report's own default sort.
    expect(res.body.data.sort).toEqual({ by: 'invoiceDate', dir: 'desc' });
  });

  it('will not sort by a column the caller may not see', async () => {
    const res = await getReport('sales/summary', clerkCookie, { sortBy: 'netPaise', sortDir: 'asc' });
    expect(res.status).toBe(200);
    expect(res.body.data.rows.every((r) => !('netPaise' in r))).toBe(true);
  });
});

describe('Search', () => {
  it('matches the report’s declared fields, case-insensitively', async () => {
    const all = await getReport('sales/summary', adminCookie, { limit: 100 });
    const invoiceNumber = all.body.data.rows[0].invoiceNumber;

    const byNumber = await getReport('sales/summary', adminCookie, { search: invoiceNumber.toLowerCase() });
    expect(byNumber.body.data.count).toBe(1);
    expect(byNumber.body.data.rows[0].invoiceNumber).toBe(invoiceNumber);

    const byCustomer = await getReport('sales/summary', adminCookie, { search: 'zeta' });
    expect(byCustomer.body.data.count).toBe(1);
    expect(byCustomer.body.data.rows[0].customerName).toBe('Zeta Constructions');
  });

  it('treats wildcards as literal text rather than as a pattern', async () => {
    const res = await getReport('sales/summary', adminCookie, { search: '%' });
    expect(res.status).toBe(200);
    // A bare % would match everything if it were passed through to LIKE.
    expect(res.body.data.count).toBe(0);
  });

  it('survives quotes and backslashes without erroring', async () => {
    for (const term of ["' OR 1=1 --", 'a\\b', '_%_']) {
      const res = await getReport('sales/summary', adminCookie, { search: term });
      expect(res.status).toBe(200);
      expect(res.body.data.count).toBe(0);
    }
  });
});

describe('Organization isolation', () => {
  it('never returns another tenant’s documents', async () => {
    const mine = await getReport('sales/summary', adminCookie, { limit: 100 });
    const theirs = await getReport('sales/summary', otherTenantCookie, { limit: 100 });

    expect(mine.body.data.count).toBe(4);
    expect(theirs.body.data.count).toBe(1);
    expect(theirs.body.data.rows[0].customerName).toBe('Rival Concretes Buyer');

    const myCustomers = mine.body.data.rows.map((r) => r.customerName);
    expect(myCustomers).not.toContain('Rival Concretes Buyer');
    // Our own quantity is 10 + 20 + 5 (factory A) + 7 (factory B). The other
    // tenant's invoice was for 99 units — a figure that would stand out
    // immediately if it leaked into our totals.
    expect(mine.body.data.summary.quantity).toBe(42);
  });

  it('isolates every report, not just the one under test', async () => {
    for (const path of ['sales/by-customer', 'inventory/current-stock', 'finance/day-book', 'customer/summary']) {
      const mine = await getReport(path, adminCookie, { limit: 100 });
      const theirs = await getReport(path, otherTenantCookie, { limit: 100 });
      expect(mine.status).toBe(200);
      expect(theirs.status).toBe(200);
      const mineIds = new Set(mine.body.data.rows.map((r) => r.id));
      for (const row of theirs.body.data.rows) expect(mineIds.has(row.id)).toBe(false);
    }
  });
});

describe('Location (factory) isolation', () => {
  it('restricts a scoped user to the factories they are assigned to', async () => {
    const admin = await getReport('sales/summary', adminCookie, { limit: 100 });
    const manager = await getReport('sales/summary', managerCookie, { limit: 100 });

    expect(admin.body.data.count).toBe(4);
    expect(manager.body.data.count).toBe(3);
    expect(manager.body.data.rows.every((r) => r.factoryName === factoryA.name)).toBe(true);
  });

  it('refuses an explicit request for a factory outside the user’s scope', async () => {
    const res = await getReport('sales/summary', managerCookie, { factoryId: factoryB.id });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/access to this factory/i);
  });

  it('allows an explicit request for a factory inside the user’s scope', async () => {
    const res = await getReport('sales/summary', managerCookie, { factoryId: factoryA.id });
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(3);
  });

  it('applies the same scope to the summary as to the rows', async () => {
    const manager = await getReport('sales/summary', managerCookie, { limit: 100 });
    const rowTotal = manager.body.data.rows.reduce((sum, r) => sum + r.netPaise, 0);
    expect(manager.body.data.summary.netPaise).toBe(rowTotal);
  });
});

describe('Field-level security (BR-27)', () => {
  it('removes money columns from the definition for a user without VIEW_RATES', async () => {
    const res = await getReport('sales/summary', clerkCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.columns.some((c) => c.type === 'money')).toBe(false);
    expect(res.body.data.columns.some((c) => c.key === 'invoiceNumber')).toBe(true);
  });

  it('removes the values too — not just the column headers', async () => {
    const res = await getReport('sales/summary', clerkCookie);
    for (const row of res.body.data.rows) {
      for (const key of ['grossPaise', 'taxPaise', 'netPaise', 'paidPaise', 'outstandingPaise']) {
        expect(key in row).toBe(false);
      }
      // Non-money fields still come through: this is stripping, not blanking.
      expect(typeof row.invoiceNumber).toBe('string');
      expect(typeof row.quantity).toBe('number');
    }
  });

  it('removes money tiles from the summary', async () => {
    const res = await getReport('sales/summary', clerkCookie);
    expect('netPaise' in res.body.data.summary).toBe(false);
    expect(res.body.data.summary.invoiceCount).toBe(4);
    expect(res.body.data.metrics.some((m) => m.type === 'money')).toBe(false);
  });

  it('still serves money to a user who does hold the grant', async () => {
    const res = await getReport('sales/summary', managerCookie);
    expect(res.body.data.columns.some((c) => c.key === 'netPaise')).toBe(true);
    expect(res.body.data.rows.every((r) => typeof r.netPaise === 'number')).toBe(true);
  });
});

describe('Export', () => {
  const exportUrl = (path, query = {}) => ({ path: `${API}/${path}/export`, query });

  it('produces a real workbook, a real PDF and a real CSV', async () => {
    const xlsx = await request(app)
      .get(`${API}/sales/summary/export`)
      .set('Cookie', adminCookie)
      .query({ format: 'xlsx' })
      .responseType('blob');
    expect(xlsx.status).toBe(200);
    expect(xlsx.headers['content-type']).toMatch(/spreadsheetml/);
    expect(xlsx.headers['content-disposition']).toMatch(/attachment; filename="sales-summary-/);
    // A .xlsx is a zip: it must start with the PK local-file-header signature.
    expect(xlsx.body.slice(0, 2).toString('latin1')).toBe('PK');
    expect(xlsx.body.length).toBeGreaterThan(3000);

    const pdf = await request(app)
      .get(`${API}/sales/summary/export`)
      .set('Cookie', adminCookie)
      .query({ format: 'pdf' })
      .responseType('blob');
    expect(pdf.status).toBe(200);
    expect(pdf.headers['content-type']).toBe('application/pdf');
    expect(pdf.body.slice(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.body.length).toBeGreaterThan(2000);

    const csv = await request(app).get(`${API}/sales/summary/export`).set('Cookie', adminCookie).query({ format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.text).toContain('Bhuasuni Precast');
    expect(csv.text).toContain('Invoice No');
  });

  it('exports the whole filtered result set, not the page the client last asked for', async () => {
    const csv = await request(app)
      .get(`${API}/sales/summary/export`)
      .set('Cookie', adminCookie)
      .query({ format: 'csv', limit: 1, page: 1 });

    // Count the rows after the header rather than matching a document-number
    // prefix, which is per-factory configuration and not what this asserts.
    const lines = csv.text.split('\r\n');
    const headerIndex = lines.findIndex((line) => line.startsWith('Invoice No'));
    const dataLines = lines.slice(headerIndex + 1).filter((line) => line.trim().length > 0);
    expect(headerIndex).toBeGreaterThan(-1);
    expect(dataLines).toHaveLength(4);
  });

  it('respects the filters that were applied', async () => {
    const csv = await request(app)
      .get(`${API}/sales/summary/export`)
      .set('Cookie', adminCookie)
      .query({ format: 'csv', customerId: otherCustomer.id });

    expect(csv.text).toContain('Zeta Constructions');
    expect(csv.text).toContain('Customer: Zeta Constructions');
    expect(csv.text).not.toContain('Bhuasuni Precast Buyer');
  });

  it('respects location scope', async () => {
    const csv = await request(app).get(`${API}/sales/summary/export`).set('Cookie', managerCookie).query({ format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.text).toContain(factoryA.name);
    expect(csv.text).not.toContain(factoryB.name);

    const denied = await request(app).get(`${API}/sales/summary/export`).set('Cookie', managerCookie).query({ format: 'csv', factoryId: factoryB.id });
    expect(denied.status).toBe(403);
  });

  it('requires the export grant, not just the read grant', async () => {
    expect((await getReport('sales/summary', clerkCookie)).status).toBe(200);
    const res = await request(app).get(`${API}/sales/summary/export`).set('Cookie', clerkCookie).query({ format: 'csv' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/permission to export/i);
  });

  it('omits money from an export the same way it omits it from the screen', async () => {
    // The manager holds VIEW_RATES, so their file has the money columns.
    const withRates = await request(app).get(`${API}/sales/summary/export`).set('Cookie', managerCookie).query({ format: 'csv' });
    expect(withRates.text).toContain('Net Amount');
    expect(withRates.text).toContain('Outstanding');

    // Grant the clerk export rights but still no VIEW_RATES, and the columns
    // must be absent from the file — the server decides, not the UI.
    const group = await AdGroup.findOne({ where: { name: 'Sales Report Viewers' } });
    await group.update({ permissions: ['REPORT_SALES_READ', 'REPORT_SALES_EXPORT'] });
    const cookie = await login('clerk@rpt-main.co');

    const res = await request(app).get(`${API}/sales/summary/export`).set('Cookie', cookie).query({ format: 'csv' });
    expect(res.status).toBe(200);
    expect(res.text).toContain('Invoice No');
    expect(res.text).not.toContain('Net Amount');
    expect(res.text).not.toContain('Outstanding');
    expect(res.text).toContain('Rate and amount columns are excluded');
  });

  it('rejects an unsupported format', async () => {
    const res = await request(app).get(`${API}/sales/summary/export`).set('Cookie', adminCookie).query({ format: 'docx' });
    expect(res.status).toBe(400);
    expect(exportUrl('sales/summary').path).toBe(`${API}/sales/summary/export`);
  });
});

describe('Report metadata', () => {
  it('describes a report without running it', async () => {
    const res = await request(app).get(`${API}/sales/summary/meta`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.filters).toContain('customerId');
    expect(res.body.data.searchFields.length).toBeGreaterThan(0);
    expect(res.body.data.defaultSort).toEqual({ by: 'invoiceDate', dir: 'desc' });
    // Data the schema genuinely cannot supply is declared, not faked.
    expect(res.body.data.limitations.join(' ')).toMatch(/Sales Reference/);
  });

  it('describes only the columns the caller may receive', async () => {
    const res = await request(app).get(`${API}/sales/summary/meta`).set('Cookie', clerkCookie);
    expect(res.body.data.columns.some((c) => c.type === 'money')).toBe(false);
    expect(res.body.data.canExport).toBe(false);
  });
});

describe('Every registered report', () => {
  it('runs, paginates and reports a coherent envelope', async () => {
    for (const definition of allReports()) {
      const res = await getReport(definition.path, adminCookie, { limit: 5 });
      expect([definition.id, res.status]).toEqual([definition.id, 200]);

      const { rows, count, totalPages, columns, summary } = res.body.data;
      expect(Array.isArray(rows)).toBe(true);
      expect(rows.length).toBeLessThanOrEqual(5);
      expect(count).toBeGreaterThanOrEqual(rows.length);
      expect(totalPages).toBeGreaterThanOrEqual(1);
      expect(summary).toBeTruthy();
      // A KPI report has no table; every other report must publish columns.
      if (definition.kind === 'table') expect(columns.length).toBeGreaterThan(0);
    }
  }, 120000);

  it('exports in all three formats', async () => {
    for (const definition of allReports()) {
      for (const format of ['xlsx', 'pdf', 'csv']) {
        const res = await request(app)
          .get(`${API}/${definition.path}/export`)
          .set('Cookie', adminCookie)
          .query({ format })
          .responseType('blob');
        expect([definition.id, format, res.status]).toEqual([definition.id, format, 200]);
        const size = res.body?.length ?? res.text?.length ?? 0;
        expect([definition.id, format, size > 200]).toEqual([definition.id, format, true]);
      }
    }
  }, 240000);
});

describe('Cross-report consistency', () => {
  it('reports the same stock the inventory module holds', async () => {
    const report = await getReport('inventory/current-stock', adminCookie, { limit: 100 });
    expect(report.status).toBe(200);

    const lots = await request(app)
      .get('/api/v1/inventory/lots')
      .set('Cookie', adminCookie)
      .query({ page: 1, limit: 100, factoryId: factoryA.id, productId: finishedGood.id });

    const lotTotal = lots.body.data.rows
      .filter((l) => l.status === 'AVAILABLE')
      .reduce((sum, l) => sum + Number(l.qtyAvailable), 0);
    const reportRow = report.body.data.rows.find(
      (r) => r.productCode === finishedGood.code && r.factoryName === factoryA.name
    );

    expect(reportRow).toBeTruthy();
    expect(reportRow.closingStock).toBeCloseTo(lotTotal, 4);
  });

  it('reports receivables that match the invoices they came from', async () => {
    const sales = await getReport('sales/summary', adminCookie, { limit: 100 });
    const receivables = await getReport('finance/receivables', adminCookie, { limit: 100 });

    const outstandingFromSales = sales.body.data.rows.reduce((sum, r) => sum + r.outstandingPaise, 0);
    expect(receivables.body.data.summary.outstandingPaise).toBe(outstandingFromSales);
  });

  it('derives the sales due date from the customer’s configured credit period', async () => {
    // Zeta is configured with 15 credit days; the invoice is dated 20-Aug.
    const res = await getReport('customer/outstanding', adminCookie, { customerId: otherCustomer.id, limit: 10 });
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.rows[0].dueDate).toBe('2026-09-04');
  });
});
