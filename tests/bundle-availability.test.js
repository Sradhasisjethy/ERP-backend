/**
 * Bundle available-to-promise — Phase 6.
 * docs/specs/bundle-kitting.md §8:
 *
 *   available bundles = min over components of floor(available_i / qty_i)
 *
 * The point of the whole phase: nobody stocks "Printer X with starter kit".
 * They stock printers, cables and toner, and how many complete bundles can be
 * promised is a question about the scarcest of them — so a salesperson is never
 * told yes on the strength of the parent's own stock alone.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, Party,
} = require('../src/models/index');
const { BundleRule } = require('../src/api/bundles/bundleRule.model');
const { BundleComponent } = require('../src/api/bundles/bundleComponent.model');

const PASSWORD = 'password123';
let tenantId;
let factory;
let printer;
let cable;   // 2 per bundle, PROPORTIONAL
let toner;   // 1 per bundle, PROPORTIONAL
let kit;     // FIXED — one per order, so never the constraint
let vendor;
let adminCookie;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

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

const atp = async (productId) =>
  request(app)
    .get(`/api/v1/bundles/products/${productId}/available-bundles?factoryId=${factory.id}&onDate=2026-08-01`)
    .set('Cookie', adminCookie);

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Atp Co', slug: 'atp-co', status: 'active' });
  tenantId = tenant.id;

  const org = await Organization.create({ tenantId, name: 'Atp Co Ltd', code: 'ATP' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Atp Plant', code: 'ATP-FAC', varianceThresholdPercent: 5, state: 'Odisha' });

  await User.create(
    { tenantId, email: 'admin@atp.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-ATP' });
  const hsn = await HsnCode.create({ tenantId, code: '8443', description: 'Printers', gstRatePercent: 18 });

  printer = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Printer X', code: 'ATP-PRN', productType: 'FINISHED_GOOD' });
  cable = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Cable a1', code: 'ATP-CAB', productType: 'FINISHED_GOOD' });
  toner = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Toner b1', code: 'ATP-TNR', productType: 'FINISHED_GOOD' });
  kit = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Install kit c1', code: 'ATP-KIT', productType: 'FINISHED_GOOD' });

  vendor = await Party.create({ tenantId, name: 'Atp Vendor', code: 'ATP-V', partyType: 'VENDOR', status: 'active' });

  const rule = await BundleRule.create({
    tenantId, code: 'ATP-KIT-RULE', name: 'Printer X starter kit', parentProductId: printer.id,
    status: 'ACTIVE', effectiveFrom: '2026-04-01', version: 1,
  });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: cable.id, quantity: 2, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 1 });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: toner.id, quantity: 1, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 2 });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: kit.id, quantity: 1, scalingMode: 'FIXED', uomId: uom.id, sequence: 3 });

  adminCookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@atp.co', password: PASSWORD }),
    'accessToken'
  );
});

afterAll(async () => {
  await sequelize.close();
});

describe('available bundles', () => {
  it('promises nothing when no component has arrived', async () => {
    const res = await atp(printer.id);
    expect(res.status).toBe(200);
    expect(res.body.data.isBundle).toBe(true);
    expect(res.body.data.availableBundles).toBe(0);
  });

  it('is capped by the scarcest component, not by the parent', async () => {
    // 100 printers, but only 30 cables at 2 each → 15 complete bundles.
    await receive([[printer, 100], [cable, 30], [toner, 50], [kit, 5]]);

    const res = await atp(printer.id);
    expect(res.status).toBe(200);
    expect(res.body.data.availableBundles).toBe(15);
    expect(res.body.data.limitedBy.productId).toBe(cable.id);
    expect(res.body.data.limitedBy.available).toBe(30);
    expect(res.body.data.limitedBy.perBundle).toBe(2);
  });

  it('counts whole bundles only', async () => {
    // 31 cables is still 15 bundles: half a printer with one cable is not
    // something anyone can be promised.
    await receive([[cable, 1]]);
    expect((await atp(printer.id)).body.data.availableBundles).toBe(15);

    await receive([[cable, 1]]);
    expect((await atp(printer.id)).body.data.availableBundles).toBe(16);
  });

  it('does not let a FIXED component cap the quantity', async () => {
    // Only 5 install kits exist, but one covers a whole order — so it must not
    // drag the promise down to 5.
    const res = await atp(printer.id);
    expect(res.body.data.availableBundles).toBeGreaterThan(5);
    expect(res.body.data.constraints.some((c) => c.productId === kit.id)).toBe(false);
  });

  it('falls back to the parent when it is the scarcest', async () => {
    await receive([[cable, 1000], [toner, 1000]]);

    const res = await atp(printer.id);
    expect(res.body.data.availableBundles).toBe(100);   // the printers
    expect(res.body.data.limitedBy.productId).toBe(printer.id);
  });

  it('answers for an ordinary product with its own stock', async () => {
    const res = await atp(cable.id);
    expect(res.status).toBe(200);
    expect(res.body.data.isBundle).toBe(false);
    expect(res.body.data.availableBundles).toBeGreaterThan(0);
  });

  it('refuses a request naming a factory the caller cannot use', async () => {
    const res = await request(app)
      .get(`/api/v1/bundles/products/${printer.id}/available-bundles?factoryId=${factory.id}`)
      .set('Cookie', '');
    expect(res.status).toBe(401);
  });

  it('requires a factory rather than guessing one', async () => {
    const res = await request(app)
      .get(`/api/v1/bundles/products/${printer.id}/available-bundles`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });
});
