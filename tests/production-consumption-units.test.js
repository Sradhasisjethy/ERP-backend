/**
 * PRD — what a casting run actually consumes.
 *
 * Production used to compute its own requirement as `quantityPerUnit * goodQty`,
 * ignoring both the wastage allowance and the unit the material is stocked in.
 * BomService.explode() has always done it correctly; production simply did not
 * call it. That produced three faults at once, all silent:
 *
 *   - availability compared kilograms against cubic metres, blocking runs there
 *     was ample material for;
 *   - the declared wastage percentage did nothing;
 *   - where a run did pass, the wrong quantity left inventory.
 *
 * The fixture mirrors the shape that exposed it: a recipe written in KG for a
 * material stocked in CUM, alongside one whose units already agree.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, UomConversion,
  Product, MixDesign, MixDesignLine, Party, MaterialConsumption,
} = require('../src/models/index');
const { app } = require('../src/app');

const PASSWORD = 'password123';
let adminCookie;
let factory;
let pipe;
let aggregate;   // recipe in KG, stocked in CUM
let cement;      // recipe in BAG, stocked in BAG
let vendor;

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const stockIn = async (product, qty) => {
  const res = await request(app).post('/api/v1/purchasing/receipts').set('Cookie', adminCookie).send({
    factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-07-01',
    lines: [{ productId: product.id, receivedQty: qty, ratePaise: 1000 }],
  });
  expect(res.status).toBe(201);
};

const balance = async (product) => {
  const res = await request(app)
    .get(`/api/v1/sales/atp?factoryId=${factory.id}&productId=${product.id}`)
    .set('Cookie', adminCookie);
  return Number(res.body.data.onHand);
};

const cast = (goodQty, extra = {}) =>
  request(app).post('/api/v1/production/entries').set('Cookie', adminCookie)
    .send({ factoryId: factory.id, productId: pipe.id, productionDate: '2026-08-20', goodQty, ...extra });

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Units Co', slug: 'units-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Units Co Ltd', code: 'UC' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Units Plant', code: 'UC-FAC', varianceThresholdPercent: 5 });

  await User.create(
    { tenantId, email: 'admin@units.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'A', lastName: 'B', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  const kg = await Uom.create({ tenantId, name: 'Kilogram', code: 'KG-U' });
  const cum = await Uom.create({ tenantId, name: 'Cubic Meter', code: 'CUM-U' });
  const bag = await Uom.create({ tenantId, name: 'Bag', code: 'BAG-U' });
  const nos = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-U' });

  // 1 CUM of aggregate weighs 1500 KG.
  await UomConversion.create({ tenantId, fromUomId: cum.id, toUomId: kg.id, factor: 1500, status: 'active' });

  pipe = await Product.create({ tenantId, uomId: nos.id, name: 'RCC Pipe', code: 'FG-PIPE-U', productType: 'FINISHED_GOOD', curingDays: 0 });
  aggregate = await Product.create({ tenantId, uomId: cum.id, name: 'Aggregate', code: 'RM-AGG-U', productType: 'RAW_MATERIAL' });
  cement = await Product.create({ tenantId, uomId: bag.id, name: 'Cement', code: 'RM-CEM-U', productType: 'RAW_MATERIAL' });

  vendor = await Party.create({ tenantId, name: 'Units Vendor', code: 'V-U', partyType: 'VENDOR', status: 'active' });

  const bom = await MixDesign.create({
    tenantId, productId: pipe.id, name: 'Units Mix', version: 1,
    outputQuantity: 1, status: 'ACTIVE', isActive: true, effectiveFrom: '2026-04-01',
  });
  // Written in KG for a material stocked in CUM — the case that broke.
  await MixDesignLine.create({ tenantId, mixDesignId: bom.id, rawMaterialProductId: aggregate.id, quantityPerUnit: 380, wastagePercent: 2, uomId: kg.id });
  // Units already agree; only the wastage matters here.
  await MixDesignLine.create({ tenantId, mixDesignId: bom.id, rawMaterialProductId: cement.id, quantityPerUnit: 2.4, wastagePercent: 2, uomId: bag.id });

  adminCookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@units.co', password: PASSWORD }),
    'accessToken'
  );
});

afterAll(async () => {
  await sequelize.close();
});

describe('a recipe written in a different unit from the stock', () => {
  it('does not block a run there is plenty of material for', async () => {
    // 30 pipes need 380 x 30 x 1.02 = 11,628 KG = 7.752 CUM of aggregate.
    // 20 CUM is ample — but the old check compared 11,400 against 20 and refused.
    await stockIn(aggregate, 20);
    await stockIn(cement, 500);

    const res = await cast(30);
    expect(res.status).toBe(201);
  });

  it('consumes the converted quantity, not the recipe number', async () => {
    const before = await balance(aggregate);
    await cast(10);
    const after = await balance(aggregate);

    // 380 x 10 x 1.02 = 3,800 KG -> 2.584 CUM.
    expect(Number((before - after).toFixed(4))).toBe(2.584);
  });

  it('records the converted figure as what the mix design asked for', async () => {
    const res = await cast(10);
    const consumption = await MaterialConsumption.findAll({ where: { productionEntryId: res.body.data.id } });
    const agg = consumption.find((c) => c.rawMaterialProductId === aggregate.id);

    // A variance is measured against this, so it has to be the real requirement
    // — otherwise every run reads as thousands of percent out.
    expect(Number(agg.mixDesignQty)).toBeCloseTo(2.584, 3);
    expect(Number(agg.variancePercent)).toBe(0);
  });
});

describe('the declared wastage allowance', () => {
  it('is consumed, even when the units already agree', async () => {
    const before = await balance(cement);
    await cast(10);
    const after = await balance(cement);

    // 2.4 x 10 = 24 bags of recipe, +2% = 24.48 actually leaving the yard.
    // Consuming the bare 24 is how stock drifts low by exactly the wastage on
    // every single run.
    expect(Number((before - after).toFixed(4))).toBe(24.48);
  });
});

describe('a genuine shortage is still refused', () => {
  it('blocks when the converted requirement really does exceed stock', async () => {
    // Aggregate is down to a little over 9 CUM; 100 pipes need 25.84.
    const res = await cast(100);

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Not enough raw material/);
    // And it names the shortfall in the stocking unit rather than the recipe's.
    expect(res.body.message).toMatch(/Aggregate/);
  });
});

describe('a recipe unit with no route to the stocking unit', () => {
  it('refuses, and says which material and what to do about it', async () => {
    // The realistic new-material case: someone adds an admixture stocked in
    // litres and writes the recipe in millilitres, without defining the
    // conversion. Guessing a factor would be far worse than refusing.
    const litre = await Uom.create({ tenantId: factory.tenantId, name: 'Litre', code: 'LTR-U' });
    const millilitre = await Uom.create({ tenantId: factory.tenantId, name: 'Millilitre', code: 'ML-U' });

    const admixture = await Product.create({
      tenantId: factory.tenantId, uomId: litre.id, name: 'Admixture',
      code: 'RM-ADMIX-U', productType: 'RAW_MATERIAL',
    });

    // Only one recipe may be active per product, so the existing one is
    // superseded rather than duplicated — the same route a real user takes.
    await MixDesign.update(
      { isActive: false, status: 'SUPERSEDED' },
      { where: { productId: pipe.id, isActive: true } }
    );

    const bom = await MixDesign.create({
      tenantId: factory.tenantId, productId: pipe.id, name: 'Admix Mix', version: 2,
      outputQuantity: 1, status: 'ACTIVE', isActive: true, effectiveFrom: '2026-08-19',
    });
    await MixDesignLine.create({
      tenantId: factory.tenantId, mixDesignId: bom.id, rawMaterialProductId: admixture.id,
      quantityPerUnit: 500, wastagePercent: 0, uomId: millilitre.id,
    });

    const res = await cast(1);

    expect(res.status).toBe(400);
    // Naming the material and the two units is the difference between an
    // actionable message and "no conversion is defined between that unit and
    // that unit" on a screen listing a dozen materials.
    expect(res.body.message).toMatch(/Admixture/);
    expect(res.body.message).toMatch(/LTR-U/);
    expect(res.body.message).toMatch(/ML-U/);
    expect(res.body.message).toMatch(/UoM Conversions/i);
  });
});
