/**
 * Bundle command API — Phase 3 acceptance criteria.
 * docs/specs/bundle-kitting.md §6, and §7 tests 9, 13, 15.
 *
 * Phase 2 proved the service does the right thing. This proves the endpoints
 * expose it safely: the right permission, the right envelope, and — the part
 * that actually bites in the field — a retry on a flaky connection producing
 * one printer rather than two.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, Party,
  PriceList, PriceListItem, SalesOrder, SalesOrderLine, AdGroup, AdGroupMember, UserFactory,
} = require('../src/models/index');
const { BundleRule } = require('../src/api/bundles/bundleRule.model');
const { BundleComponent } = require('../src/api/bundles/bundleComponent.model');
const { OverrideReasonCode } = require('../src/api/bundles/overrideReasonCode.model');

const PASSWORD = 'password123';
let tenantId;
let factory;
let printer;
let cable;
let toner;
let kit;      // mandatory
let manual;   // optional
let customer;
let vendor;
let adminCookie;
let salesCookie;   // SALES_* but no mandatory-override grant

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const login = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

const createOrder = async (cookie = adminCookie, qty = 1) => {
  const res = await request(app).post('/api/v1/sales/orders').set('Cookie', cookie).send({
    factoryId: factory.id,
    customerPartyId: customer.id,
    orderDate: '2026-08-01',
    lines: [{ productId: printer.id, orderedQty: qty, ratePaise: 5000000 }],
  });
  expect(res.status).toBe(201);
  return res.body.data;
};

const linesOf = async (orderId) => SalesOrderLine.findAll({ where: { salesOrderId: orderId } });
const parentOf = async (orderId) => (await linesOf(orderId)).find((l) => l.lineRole === 'PARENT');
const componentOf = async (orderId, productId) =>
  (await linesOf(orderId)).find((l) => l.lineRole === 'COMPONENT' && l.productId === productId);

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Cmd Co', slug: 'cmd-co', status: 'active' });
  tenantId = tenant.id;

  const org = await Organization.create({ tenantId, name: 'Cmd Co Ltd', code: 'CMD' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Cmd Plant', code: 'CMD-FAC', varianceThresholdPercent: 5, state: 'Odisha' });

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@cmd.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  // A salesperson with the ordinary sales grants and nothing more. BR-29 means
  // they also need the factory assignment, or every request is a 403 for the
  // wrong reason.
  const sales = await User.create(
    { tenantId, email: 'sales@cmd.co', passwordHash, firstName: 'Sales', lastName: 'Person', role: 'EMPLOYEE' },
    { validate: false }
  );
  const group = await AdGroup.create({
    tenantId, name: 'Sales Desk', status: 'active',
    permissions: ['SALES_READ', 'SALES_CREATE', 'SALES_MODIFY', 'PRODUCT_READ', 'PARTY_READ'],
  });
  await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: sales.id });
  await UserFactory.create({ tenantId, userId: sales.id, factoryId: factory.id });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-CMD' });
  const hsn18 = await HsnCode.create({ tenantId, code: '8443', description: 'Printers', gstRatePercent: 18 });
  const hsn12 = await HsnCode.create({ tenantId, code: '8544', description: 'Cables', gstRatePercent: 12 });

  printer = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Printer X', code: 'CMD-PRN', productType: 'FINISHED_GOOD' });
  cable = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn12.id, name: 'Cable a1', code: 'CMD-CAB', productType: 'FINISHED_GOOD' });
  toner = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Toner b1', code: 'CMD-TNR', productType: 'FINISHED_GOOD' });
  kit = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Install kit c1', code: 'CMD-KIT', productType: 'FINISHED_GOOD' });
  manual = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn12.id, name: 'Manual d1', code: 'CMD-MAN', productType: 'FINISHED_GOOD' });

  customer = await Party.create({ tenantId, name: 'Cmd Customer', code: 'CMD-C', partyType: 'CUSTOMER', status: 'active', state: 'Odisha' });
  vendor = await Party.create({ tenantId, name: 'Cmd Vendor', code: 'CMD-V', partyType: 'VENDOR', status: 'active' });

  const pl = await PriceList.create({ tenantId, name: 'Retail', priceType: 'RETAIL', status: 'active' });
  for (const [product, paise] of [[printer, 5000000], [cable, 25000], [toner, 450000], [kit, 120000], [manual, 15000]]) {
    await PriceListItem.create({ tenantId, priceListId: pl.id, productId: product.id, ratePaise: paise });
  }

  await OverrideReasonCode.create({ tenantId, code: 'ALREADY_HAS', label: 'Customer already has one' });

  const rule = await BundleRule.create({
    tenantId, code: 'PRN-X-KIT', name: 'Printer X starter kit', parentProductId: printer.id,
    status: 'ACTIVE', effectiveFrom: '2026-04-01', version: 1,
  });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: cable.id, quantity: 2, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 1 });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: toner.id, quantity: 1, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 2 });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: kit.id, quantity: 1, scalingMode: 'FIXED', uomId: uom.id, isMandatory: true, sequence: 3 });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: manual.id, quantity: 1, scalingMode: 'FIXED', uomId: uom.id, defaultSelected: false, sequence: 4 });

  adminCookie = await login('admin@cmd.co');
  salesCookie = await login('sales@cmd.co');
});

afterAll(async () => {
  await sequelize.close();
});

describe('the response envelope', () => {
  it('returns the whole order and its warnings from every command', async () => {
    const order = await createOrder();
    const parent = await parentOf(order.id);

    const res = await request(app)
      .patch(`/api/v1/sales/orders/${order.id}/lines/${parent.id}/quantity`)
      .set('Cookie', adminCookie)
      .send({ qty: 3 });

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveProperty('order');
    expect(res.body.data).toHaveProperty('warnings');
    expect(Array.isArray(res.body.data.warnings)).toBe(true);
    // The whole order comes back, so the client never re-fetches to see what moved.
    expect(res.body.data.order.lines.length).toBe(4);
  });
});

describe('POST /lines — add a product and its accessories', () => {
  it('adds the parent and expands it in one call', async () => {
    const order = await createOrder();

    // A second printer: a separate configuration, not a merge.
    const res = await request(app)
      .post(`/api/v1/sales/orders/${order.id}/lines`)
      .set('Cookie', adminCookie)
      .send({ productId: printer.id, orderedQty: 2 });

    expect(res.status).toBe(200);
    const parents = (await linesOf(order.id)).filter((l) => l.lineRole === 'PARENT');
    expect(parents).toHaveLength(2);
    expect((await linesOf(order.id)).filter((l) => l.lineRole === 'COMPONENT')).toHaveLength(6);
  });

  it('refuses a repeat of an ordinary product', async () => {
    const order = await createOrder();
    await request(app).post(`/api/v1/sales/orders/${order.id}/lines`).set('Cookie', adminCookie)
      .send({ productId: manual.id, orderedQty: 1 });

    const res = await request(app).post(`/api/v1/sales/orders/${order.id}/lines`).set('Cookie', adminCookie)
      .send({ productId: manual.id, orderedQty: 1 });

    expect(res.status).toBe(400);
  });
});

describe('Test 13 — a price override survives a quantity change', () => {
  it('keeps the typed price and rescales the quantity', async () => {
    const order = await createOrder();
    const parent = await parentOf(order.id);
    const cableLine = await componentOf(order.id, cable.id);

    // Priced by hand on the line, then the parent quantity moves.
    await cableLine.update({ ratePaise: 19999, syncState: 'PRICE_OVERRIDDEN' });

    const res = await request(app)
      .patch(`/api/v1/sales/orders/${order.id}/lines/${parent.id}/quantity`)
      .set('Cookie', adminCookie)
      .send({ qty: 3 });
    expect(res.status).toBe(200);

    const after = await componentOf(order.id, cable.id);
    expect(Number(after.ratePaise)).toBe(19999);            // untouched
    expect(Number(after.systemUnitPricePaise)).toBe(25000); // list price, for the badge
    expect(Number(after.orderedQty)).toBe(6);               // quantity still scales
  });
});

describe('Test 14 — removing a mandatory component', () => {
  it('refuses a salesperson without the grant, with a code the client can act on', async () => {
    const order = await createOrder(salesCookie);
    const kitLine = await componentOf(order.id, kit.id);

    const res = await request(app)
      .post(`/api/v1/sales/orders/${order.id}/lines/${kitLine.id}/suppress`)
      .set('Cookie', salesCookie)
      .send({ reasonCode: 'ALREADY_HAS' });

    expect(res.status).toBe(403);
    expect(res.body.code).toBe('BUNDLE_MANDATORY_COMPONENT');
    expect(await componentOf(order.id, kit.id)).toBeDefined();   // no state change
  });

  it('allows it for someone who holds the grant', async () => {
    const order = await createOrder();
    const kitLine = await componentOf(order.id, kit.id);

    const res = await request(app)
      .post(`/api/v1/sales/orders/${order.id}/lines/${kitLine.id}/suppress`)
      .set('Cookie', adminCookie)
      .send({ reasonCode: 'ALREADY_HAS' });

    expect(res.status).toBe(200);
    expect(await componentOf(order.id, kit.id)).toBeUndefined();
  });

  it('lets an ordinary salesperson remove an ordinary accessory', async () => {
    const order = await createOrder(salesCookie);
    const cableLine = await componentOf(order.id, cable.id);

    const res = await request(app)
      .post(`/api/v1/sales/orders/${order.id}/lines/${cableLine.id}/suppress`)
      .set('Cookie', salesCookie)
      .send({ reasonCode: 'ALREADY_HAS' });

    expect(res.status).toBe(200);
    expect(await componentOf(order.id, cable.id)).toBeUndefined();
  });
});

describe('restore, optional accessories and reset over HTTP', () => {
  it('puts a removed accessory back', async () => {
    const order = await createOrder();
    const parent = await parentOf(order.id);
    const cableLine = await componentOf(order.id, cable.id);

    await request(app).post(`/api/v1/sales/orders/${order.id}/lines/${cableLine.id}/suppress`)
      .set('Cookie', adminCookie).send({ reasonCode: 'ALREADY_HAS' });

    const res = await request(app)
      .post(`/api/v1/sales/orders/${order.id}/lines/${parent.id}/restore`)
      .set('Cookie', adminCookie)
      .send({ componentProductId: cable.id });

    expect(res.status).toBe(200);
    expect(await componentOf(order.id, cable.id)).toBeDefined();
  });

  it('lists and adds an optional accessory', async () => {
    const order = await createOrder();
    const parent = await parentOf(order.id);

    const list = await request(app)
      .get(`/api/v1/sales/orders/${order.id}/lines/${parent.id}/available-accessories`)
      .set('Cookie', adminCookie);
    expect(list.status).toBe(200);
    expect(list.body.data.map((a) => a.componentProductId)).toEqual([manual.id]);

    const res = await request(app)
      .post(`/api/v1/sales/orders/${order.id}/lines/${parent.id}/components`)
      .set('Cookie', adminCookie)
      .send({ productId: manual.id });

    expect(res.status).toBe(200);
    expect(await componentOf(order.id, manual.id)).toBeDefined();
  });

  it('resets an overridden component', async () => {
    const order = await createOrder();
    const tonerLine = await componentOf(order.id, toner.id);

    await request(app).patch(`/api/v1/sales/orders/${order.id}/lines/${tonerLine.id}/quantity`)
      .set('Cookie', adminCookie).send({ qty: 9 });
    expect(Number((await componentOf(order.id, toner.id)).orderedQty)).toBe(9);

    const res = await request(app)
      .post(`/api/v1/sales/orders/${order.id}/lines/${tonerLine.id}/reset`)
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    const after = await componentOf(order.id, toner.id);
    expect(after.syncState).toBe('SYNCED');
    expect(Number(after.orderedQty)).toBe(1);
  });

  it('deletes a parent and its whole group', async () => {
    const order = await createOrder();
    const parent = await parentOf(order.id);

    const res = await request(app)
      .delete(`/api/v1/sales/orders/${order.id}/lines/${parent.id}`)
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    expect(await linesOf(order.id)).toHaveLength(0);
  });
});

describe('Test 15 — a retry must not produce two cables', () => {
  it('replays the first response instead of acting twice', async () => {
    const order = await createOrder();
    const key = `add-line-${order.id}`;
    const body = { productId: printer.id, orderedQty: 2 };

    const first = await request(app).post(`/api/v1/sales/orders/${order.id}/lines`)
      .set('Cookie', adminCookie).set('Idempotency-Key', key).send(body);
    expect(first.status).toBe(200);

    const linesAfterFirst = (await linesOf(order.id)).length;

    const replay = await request(app).post(`/api/v1/sales/orders/${order.id}/lines`)
      .set('Cookie', adminCookie).set('Idempotency-Key', key).send(body);

    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);              // identical response
    expect((await linesOf(order.id)).length).toBe(linesAfterFirst);   // no duplicate
  });

  it('refuses the same key used for a different request', async () => {
    const order = await createOrder();
    const key = `reused-${order.id}`;

    await request(app).post(`/api/v1/sales/orders/${order.id}/lines`)
      .set('Cookie', adminCookie).set('Idempotency-Key', key)
      .send({ productId: printer.id, orderedQty: 2 });

    const res = await request(app).post(`/api/v1/sales/orders/${order.id}/lines`)
      .set('Cookie', adminCookie).set('Idempotency-Key', key)
      .send({ productId: printer.id, orderedQty: 7 });

    expect(res.status).toBe(409);
  });

  it('still works without a key, so existing clients are unaffected', async () => {
    const order = await createOrder();
    const res = await request(app).post(`/api/v1/sales/orders/${order.id}/lines`)
      .set('Cookie', adminCookie).send({ productId: printer.id, orderedQty: 1 });
    expect(res.status).toBe(200);
  });
});

/** Stock arrives the way it really does, through a goods receipt. */
const receive = async (entries) => {
  const res = await request(app).post('/api/v1/purchasing/receipts').set('Cookie', adminCookie).send({
    factoryId: factory.id,
    vendorPartyId: vendor.id,
    receiptDate: '2026-07-01',
    lines: entries.map(([product, qty]) => ({ productId: product.id, receivedQty: qty, ratePaise: 1000 })),
  });
  expect(res.status).toBe(201);
};

describe('Test 9 — order to challan to invoice', () => {
  it('carries every bundle state through dispatch and invoicing, and never re-expands', async () => {
    await receive([[printer, 20], [cable, 40], [toner, 40], [kit, 20]]);

    const order = await createOrder(adminCookie, 2);

    // Configure it: drop one accessory, override another's quantity.
    const kitLine = await componentOf(order.id, kit.id);
    expect(
      (await request(app).post(`/api/v1/sales/orders/${order.id}/lines/${kitLine.id}/suppress`)
        .set('Cookie', adminCookie).send({ reasonCode: 'ALREADY_HAS' })).status
    ).toBe(200);

    const tonerLine = await componentOf(order.id, toner.id);
    expect(
      (await request(app).patch(`/api/v1/sales/orders/${order.id}/lines/${tonerLine.id}/quantity`)
        .set('Cookie', adminCookie).send({ qty: 7 })).status
    ).toBe(200);

    const snapshot = async () =>
      (await linesOf(order.id))
        .map((l) => ({ productId: l.productId, qty: Number(l.orderedQty), syncState: l.syncState, origin: l.origin, lineRole: l.lineRole }))
        .sort((a, b) => a.productId.localeCompare(b.productId));

    const beforeConfirm = await snapshot();

    expect((await request(app).put(`/api/v1/sales/orders/${order.id}/confirm`).set('Cookie', adminCookie)).status).toBe(200);
    // Confirmation must not re-run expansion: the suppressed kit stays gone and
    // the overridden toner keeps the quantity a human typed.
    expect(await snapshot()).toEqual(beforeConfirm);

    const lines = await linesOf(order.id);
    const challan = await request(app).post('/api/v1/dispatch/challans').set('Cookie', adminCookie).send({
      salesOrderId: order.id,
      vehicleNumber: 'OD-02-Z-7001',
      driverName: 'B. Nayak',
      dispatchDate: '2026-08-05',
      lines: lines.map((l) => ({ salesOrderLineId: l.id, dispatchedQty: Number(l.orderedQty) })),
    });
    expect(challan.status).toBe(201);

    const invoice = await request(app).post('/api/v1/invoices').set('Cookie', adminCookie)
      .send({ challanIds: [challan.body.data.id], invoiceDate: '2026-08-06' });
    expect(invoice.status).toBe(201);

    // The whole journey leaves the bundle configuration exactly as sold.
    const afterInvoice = await snapshot();
    expect(afterInvoice).toEqual(beforeConfirm);
    expect(afterInvoice.some((l) => l.productId === kit.id)).toBe(false);
    expect(afterInvoice.find((l) => l.productId === toner.id).qty).toBe(7);

    // And the components were actually billed, not silently dropped.
    expect(invoice.body.data.lines.length).toBe(beforeConfirm.length);
  });

  it('will not let a confirmed order be re-expanded', async () => {
    await receive([[printer, 20], [cable, 40], [toner, 40], [kit, 20]]);

    const order = await createOrder();
    const parent = await parentOf(order.id);
    expect((await request(app).put(`/api/v1/sales/orders/${order.id}/confirm`).set('Cookie', adminCookie)).status).toBe(200);

    const res = await request(app)
      .patch(`/api/v1/sales/orders/${order.id}/lines/${parent.id}/quantity`)
      .set('Cookie', adminCookie)
      .send({ qty: 5 });

    expect(res.status).toBe(400);
    expect(Number((await parentOf(order.id)).orderedQty)).toBe(1);
  });
});
