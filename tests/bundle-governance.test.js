/**
 * Bundle governance — Phase 4 acceptance criteria.
 * docs/specs/bundle-kitting.md §8, and §7 test 10.
 *
 * The heart of this file is test 10, and it is the promise that makes bundles
 * safe to change: publishing version 2 of a rule must not touch an order that
 * was quoted from version 1. A salesperson who agreed a price with a customer
 * on Tuesday cannot have the order silently mean something different on
 * Wednesday because someone edited a master.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, Party,
  PriceList, PriceListItem, SalesOrderLine,
} = require('../src/models/index');
const { BundleRule } = require('../src/api/bundles/bundleRule.model');
const { BundleComponent } = require('../src/api/bundles/bundleComponent.model');
const { OverrideReasonCode } = require('../src/api/bundles/overrideReasonCode.model');
const { BundleDocumentService } = require('../src/api/bundles/bundleDocument.service');
const { runInTenantContext } = require('./helpers/tenant');

const PASSWORD = 'password123';
let tenantId;
let factory;
let uom;
let printer;
let cable;
let toner;
let kit;
let customer;
let adminCookie;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const post = (url, body) => request(app).post(url).set('Cookie', adminCookie).send(body);
const get = (url) => request(app).get(url).set('Cookie', adminCookie);

const createOrder = async (qty = 1) => {
  const res = await post('/api/v1/sales/orders', {
    factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-01',
    lines: [{ productId: printer.id, orderedQty: qty, ratePaise: 5000000 }],
  });
  expect(res.status).toBe(201);
  return res.body.data;
};

const linesOf = async (orderId) => SalesOrderLine.findAll({ where: { salesOrderId: orderId } });
const parentOf = async (orderId) => (await linesOf(orderId)).find((l) => l.lineRole === 'PARENT');
const productIdsOf = async (orderId) =>
  (await linesOf(orderId)).filter((l) => l.lineRole === 'COMPONENT').map((l) => l.productId).sort();

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Gov Co', slug: 'gov-co', status: 'active' });
  tenantId = tenant.id;

  const org = await Organization.create({ tenantId, name: 'Gov Co Ltd', code: 'GOV' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Gov Plant', code: 'GOV-FAC', varianceThresholdPercent: 5, state: 'Odisha' });

  await User.create(
    { tenantId, email: 'admin@gov.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-GOV' });
  const hsn18 = await HsnCode.create({ tenantId, code: '8443', description: 'Printers', gstRatePercent: 18 });
  const hsn12 = await HsnCode.create({ tenantId, code: '8544', description: 'Cables', gstRatePercent: 12 });

  printer = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Printer X', code: 'GOV-PRN', productType: 'FINISHED_GOOD' });
  cable = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn12.id, name: 'Cable a1', code: 'GOV-CAB', productType: 'FINISHED_GOOD' });
  toner = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Toner b1', code: 'GOV-TNR', productType: 'FINISHED_GOOD' });
  kit = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Install kit c1', code: 'GOV-KIT', productType: 'FINISHED_GOOD' });

  customer = await Party.create({ tenantId, name: 'Gov Customer', code: 'GOV-C', partyType: 'CUSTOMER', status: 'active', state: 'Odisha' });

  const pl = await PriceList.create({ tenantId, name: 'Retail', priceType: 'RETAIL', status: 'active' });
  for (const [product, paise] of [[printer, 5000000], [cable, 25000], [toner, 450000], [kit, 120000]]) {
    await PriceListItem.create({ tenantId, priceListId: pl.id, productId: product.id, ratePaise: paise });
  }

  await OverrideReasonCode.create({ tenantId, code: 'ALREADY_HAS', label: 'Customer already has one' });

  adminCookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@gov.co', password: PASSWORD }),
    'accessToken'
  );
});

afterAll(async () => {
  await sequelize.close();
});

/**
 * A published v1: printer brings a cable and a toner.
 *
 * Any earlier rule is archived first, so each test starts from one unambiguous
 * live bundle rather than inheriting whatever the previous test published.
 */
const publishV1 = async () => {
  await BundleRule.update(
    { status: 'ARCHIVED' },
    { where: { parentProductId: printer.id, status: ['ACTIVE', 'DRAFT'] } }
  );

  const draft = await post('/api/v1/bundles/rules', {
    code: `PRN-KIT-${Math.random().toString(36).slice(2, 8)}`,
    name: 'Printer starter kit',
    parentProductId: printer.id,
    effectiveFrom: '2026-04-01',
    components: [
      { componentProductId: cable.id, quantity: 2, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 1 },
      { componentProductId: toner.id, quantity: 1, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 2 },
    ],
  });
  expect(draft.status).toBe(201);
  expect(draft.body.data.status).toBe('DRAFT');

  const published = await post(`/api/v1/bundles/rules/${draft.body.data.id}/publish`, {});
  expect(published.status).toBe(200);
  return published.body.data;
};

describe('the draft/publish lifecycle', () => {
  it('creates as a draft and only expands once published', async () => {
    const draft = await post('/api/v1/bundles/rules', {
      code: 'DRAFT-ONLY', name: 'Not live yet', parentProductId: kit.id,
      effectiveFrom: '2026-04-01',
      components: [{ componentProductId: cable.id, quantity: 1, uomId: uom.id }],
    });
    expect(draft.status).toBe(201);

    // A draft is invisible to expansion: nothing is quoted from it.
    const preview = await get(`/api/v1/products/${kit.id}/bundle-preview?qty=1`);
    expect(preview.body.data.bundleRuleId).toBeNull();
  });

  it('refuses to edit a rule that orders have been quoted from', async () => {
    const rule = await publishV1();

    const res = await request(app).put(`/api/v1/bundles/rules/${rule.id}`).set('Cookie', adminCookie)
      .send({ name: 'Renamed in place' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/new version/i);
  });

  /**
   * Expansion writes a component's quantity straight onto an order line and
   * converts nothing, so a bundle stating a unit other than the product's own
   * would put the wrong quantity on the order with no error anywhere.
   */
  it('takes the unit from the product and refuses any other', async () => {
    const otherUom = await Uom.create({ tenantId, name: 'Metres', code: 'MTR-GOV' });

    const wrong = await post('/api/v1/bundles/rules', {
      code: 'WRONG-UOM', name: 'Mismatched unit', parentProductId: printer.id,
      effectiveFrom: '2026-04-01',
      components: [{ componentProductId: cable.id, quantity: 2, uomId: otherUom.id }],
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.message).toMatch(/own unit/i);

    // Omitted entirely, the server fills in the product's own unit.
    const inferred = await post('/api/v1/bundles/rules', {
      code: 'INFERRED-UOM', name: 'Unit inferred', parentProductId: printer.id,
      effectiveFrom: '2026-04-01',
      components: [{ componentProductId: cable.id, quantity: 2 }],
    });
    expect(inferred.status).toBe(201);
    expect(inferred.body.data.components[0].uomId).toBe(uom.id);
  });

  it('refuses a bundle that contains itself', async () => {
    const res = await post('/api/v1/bundles/rules', {
      code: 'SELF-REF', name: 'Infinite', parentProductId: printer.id,
      effectiveFrom: '2026-04-01',
      components: [{ componentProductId: printer.id, quantity: 1, uomId: uom.id }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/itself/i);
  });

  it('supersedes the previous version and closes its window', async () => {
    const v1 = await publishV1();

    const draft = await post(`/api/v1/bundles/rules/${v1.id}/new-version`, {});
    expect(draft.status).toBe(201);
    expect(draft.body.data.version).toBe(2);

    const published = await post(`/api/v1/bundles/rules/${draft.body.data.id}/publish`, { effectiveFrom: '2026-09-01' });
    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe('ACTIVE');

    const previous = await get(`/api/v1/bundles/rules/${v1.id}`);
    expect(previous.body.data.status).toBe('SUPERSEDED');
    // Closed the day before its replacement starts, so the two never overlap.
    expect(previous.body.data.effectiveTo).toBe('2026-08-31');
  });

  it('will not start a replacement before the version it replaces', async () => {
    const v1 = await publishV1();
    const draft = await post(`/api/v1/bundles/rules/${v1.id}/new-version`, {});

    const res = await post(`/api/v1/bundles/rules/${draft.body.data.id}/publish`, { effectiveFrom: '2026-01-01' });
    expect(res.status).toBe(400);
  });

  /**
   * Archiving must not strand a code. `create` refuses to reuse one, so if a
   * new version could only start from an ACTIVE rule there would be no way back
   * — the screen would tell you to publish a new version while offering no
   * button to do it.
   */
  it('can start a new version from an archived bundle', async () => {
    const v1 = await publishV1();

    expect((await request(app).delete(`/api/v1/bundles/rules/${v1.id}`).set('Cookie', adminCookie)).status).toBe(200);
    expect((await get(`/api/v1/bundles/rules/${v1.id}`)).body.data.status).toBe('ARCHIVED');

    // The code stays claimed, and the message says where to go.
    const reuse = await post('/api/v1/bundles/rules', {
      code: v1.code, name: 'Trying to reuse the code', parentProductId: printer.id,
      effectiveFrom: '2026-04-01',
      components: [{ componentProductId: cable.id, quantity: 1, uomId: uom.id }],
    });
    expect(reuse.status).toBe(409);
    expect(reuse.body.message).toMatch(/New version/i);

    // And that route works from an archived rule.
    const draft = await post(`/api/v1/bundles/rules/${v1.id}/new-version`, {});
    expect(draft.status).toBe(201);
    expect(draft.body.data.status).toBe('DRAFT');
    expect(draft.body.data.code).toBe(v1.code);

    const published = await post(`/api/v1/bundles/rules/${draft.body.data.id}/publish`, { effectiveFrom: '2026-10-01' });
    expect(published.status).toBe(200);
    expect(published.body.data.status).toBe('ACTIVE');
  });

  it('allows only one unpublished draft per bundle', async () => {
    const v1 = await publishV1();
    expect((await post(`/api/v1/bundles/rules/${v1.id}/new-version`, {})).status).toBe(201);
    expect((await post(`/api/v1/bundles/rules/${v1.id}/new-version`, {})).status).toBe(409);
  });
});

describe('Test 10 — a rule published mid-flight leaves open orders alone', () => {
  it('keeps the order on the version it was quoted from', async () => {
    await publishV1();
    const order = await createOrder(1);
    const parentLineId = (await parentOf(order.id)).id;

    expect(await productIdsOf(order.id)).toEqual([cable.id, toner.id].sort());

    // v2 drops the cable and adds the install kit.
    const rules = await get('/api/v1/bundles/rules?status=ACTIVE&parentProductId=' + printer.id);
    const live = rules.body.data.rows.find((r) => r.parentProductId === printer.id);
    const draft = await post(`/api/v1/bundles/rules/${live.id}/new-version`, {});
    await request(app).put(`/api/v1/bundles/rules/${draft.body.data.id}`).set('Cookie', adminCookie).send({
      components: [
        { componentProductId: toner.id, quantity: 1, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 1 },
        { componentProductId: kit.id, quantity: 1, scalingMode: 'FIXED', uomId: uom.id, sequence: 2 },
      ],
    });
    expect((await post(`/api/v1/bundles/rules/${draft.body.data.id}/publish`, { effectiveFrom: '2026-08-15' })).status).toBe(200);

    // Nothing has been asked of the order, so nothing about it has changed.
    expect(await productIdsOf(order.id)).toEqual([cable.id, toner.id].sort());

    // Even an ordinary edit keeps the frozen rule: the cable stays and scales,
    // and the new kit does not appear uninvited.
    const qtyChange = await request(app)
      .patch(`/api/v1/sales/orders/${order.id}/lines/${parentLineId}/quantity`)
      .set('Cookie', adminCookie).send({ qty: 3 });
    expect(qtyChange.status).toBe(200);

    expect(await productIdsOf(order.id)).toEqual([cable.id, toner.id].sort());
    const cableLine = (await linesOf(order.id)).find((l) => l.productId === cable.id);
    expect(Number(cableLine.orderedQty)).toBe(6);
  });

  it('adopts the new version only when explicitly refreshed', async () => {
    await publishV1();
    const order = await createOrder(1);
    const parentLineId = (await parentOf(order.id)).id;

    const rules = await get('/api/v1/bundles/rules?status=ACTIVE&parentProductId=' + printer.id);
    const live = rules.body.data.rows.find((r) => r.parentProductId === printer.id);
    const draft = await post(`/api/v1/bundles/rules/${live.id}/new-version`, {});
    await request(app).put(`/api/v1/bundles/rules/${draft.body.data.id}`).set('Cookie', adminCookie).send({
      components: [
        { componentProductId: toner.id, quantity: 1, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 1 },
        { componentProductId: kit.id, quantity: 1, scalingMode: 'FIXED', uomId: uom.id, sequence: 2 },
      ],
    });
    await post(`/api/v1/bundles/rules/${draft.body.data.id}/publish`, { effectiveFrom: '2026-07-01' });

    await runInTenantContext(tenantId, () => BundleDocumentService.refreshToLatestRule(parentLineId));

    const after = await linesOf(order.id);
    const components = after.filter((l) => l.lineRole === 'COMPONENT');

    // The kit arrives, the toner stays, and the cable is kept but no longer
    // managed — deleting a line a customer was quoted would be worse than
    // leaving it visible and marked.
    expect(components.map((l) => l.productId).sort()).toEqual([cable.id, toner.id, kit.id].sort());
    expect(components.find((l) => l.productId === cable.id).syncState).toBe('DETACHED');
    expect(components.find((l) => l.productId === kit.id).syncState).toBe('SYNCED');
  });
});

describe('reason codes are a curated list, not a text box', () => {
  it('creates, lists and deactivates without losing history', async () => {
    const created = await post('/api/v1/bundles/reason-codes', { code: 'too_expensive', label: 'Too expensive', requiresNote: false });
    expect(created.status).toBe(201);
    expect(created.body.data.code).toBe('TOO_EXPENSIVE');   // normalised

    const list = await get('/api/v1/bundles/reason-codes');
    expect(list.body.data.map((r) => r.code)).toContain('TOO_EXPENSIVE');

    expect((await request(app).delete('/api/v1/bundles/reason-codes/TOO_EXPENSIVE').set('Cookie', adminCookie)).status).toBe(200);

    // Deactivated, not deleted: suppression rows still point at it.
    expect((await get('/api/v1/bundles/reason-codes')).body.data.map((r) => r.code)).not.toContain('TOO_EXPENSIVE');
    expect((await get('/api/v1/bundles/reason-codes?includeInactive=true')).body.data.map((r) => r.code)).toContain('TOO_EXPENSIVE');
  });

  /**
   * The bug this guards against: `code` was the table's primary key, so it was
   * unique across the whole platform rather than within a tenant. The first
   * tenant to create ALREADY_HAS claimed it for everybody, and every other
   * tenant's seeding failed with a unique violation. See migration
   * 20260910000000.
   */
  it('lets a second tenant use the same code', async () => {
    const other = await Tenant.create({ name: 'Rival Co', slug: 'rival-gov-co', status: 'active' });

    await runInTenantContext(other.id, () =>
      OverrideReasonCode.create({ tenantId: other.id, code: 'ALREADY_HAS', label: 'They already own one' })
    );

    const mine = await runInTenantContext(tenantId, () =>
      OverrideReasonCode.findOne({ where: { code: 'ALREADY_HAS' } })
    );
    const theirs = await runInTenantContext(other.id, () =>
      OverrideReasonCode.findOne({ where: { code: 'ALREADY_HAS' } })
    );

    // Same code, two rows, each tenant seeing only its own wording.
    expect(mine.label).toBe('Customer already has one');
    expect(theirs.label).toBe('They already own one');
    expect(mine.id).not.toBe(theirs.id);
  });

  it('refuses a duplicate code', async () => {
    await post('/api/v1/bundles/reason-codes', { code: 'DUPE_TEST', label: 'First' });
    expect((await post('/api/v1/bundles/reason-codes', { code: 'DUPE_TEST', label: 'Second' })).status).toBe(409);
  });
});

describe('the attach-rate report', () => {
  it('counts what was offered against what survived, with the stated reasons', async () => {
    await publishV1();

    const url = '/api/v1/bundles/reports/attach-rate?groupBy=product&fromDate=2026-04-01&toDate=2027-03-31';
    const rowFor = (body, key) => body.data.rows.find((r) => r.key === key) || { offered: 0, attached: 0, removed: 0, reasons: [] };
    const reasonCount = (row, code) => (row.reasons.find((r) => r.code === code) || { count: 0 }).count;

    // Earlier tests in this file also raised orders, so the assertions are on
    // the movement this test causes rather than on absolute totals.
    const before = await get(url);
    expect(before.status).toBe(200);
    const cableBefore = rowFor(before.body, cable.id);

    // Three orders; the cable is removed from two of them.
    const orders = [await createOrder(1), await createOrder(1), await createOrder(1)];
    for (const order of orders.slice(0, 2)) {
      const cableLine = (await linesOf(order.id)).find((l) => l.productId === cable.id);
      expect(
        (await post(`/api/v1/sales/orders/${order.id}/lines/${cableLine.id}/suppress`, { reasonCode: 'ALREADY_HAS' })).status
      ).toBe(200);
    }

    const after = await get(url);
    const cableAfter = rowFor(after.body, cable.id);

    expect(cableAfter.offered - cableBefore.offered).toBe(3);
    expect(cableAfter.attached - cableBefore.attached).toBe(1);
    expect(cableAfter.removed - cableBefore.removed).toBe(2);
    expect(reasonCount(cableAfter, 'ALREADY_HAS') - reasonCount(cableBefore, 'ALREADY_HAS')).toBe(2);

    // The percentage is the two counts it is derived from, not a separate sum.
    expect(cableAfter.attachRatePercent)
      .toBeCloseTo(Math.round((cableAfter.attached / cableAfter.offered) * 1000) / 10, 5);
    expect(cableAfter.reasons[0].label).toBe('Customer already has one');

    // The toner was never removed, so it reads as a clean 100%.
    const tonerRow = rowFor(after.body, toner.id);
    expect(tonerRow.removed).toBe(0);
    expect(tonerRow.attachRatePercent).toBe(100);
  });

  it('groups by location as well as by product', async () => {
    const res = await get(`/api/v1/bundles/reports/attach-rate?groupBy=location&fromDate=2026-04-01&toDate=2027-03-31&factoryId=${factory.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.every((r) => r.key === factory.id)).toBe(true);
  });

  it('needs a date range rather than quietly scanning everything', async () => {
    expect((await get('/api/v1/bundles/reports/attach-rate?groupBy=product')).status).toBe(400);
  });

  it('shows the override trail for one order', async () => {
    await publishV1();
    const order = await createOrder(1);
    const cableLine = (await linesOf(order.id)).find((l) => l.productId === cable.id);
    await post(`/api/v1/sales/orders/${order.id}/lines/${cableLine.id}/suppress`, { reasonCode: 'ALREADY_HAS' });

    const res = await get(`/api/v1/bundles/orders/${order.id}/override-history`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].action).toBe('SUPPRESSED');
    expect(res.body.data[0].reasonCode).toBe('ALREADY_HAS');
  });
});
