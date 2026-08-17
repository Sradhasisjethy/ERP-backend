const request = require('supertest');
const bcrypt = require('bcryptjs');
const cls = require('cls-hooked');
const { NAMESPACE_NAME } = require('../src/core/tenantContext');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, ProductCategory, HsnCode, Party,
} = require('../src/models/index');
const { UomService } = require('../src/api/products/uom.service');
const { BomService } = require('../src/api/products/bom.service');
const { determineTax, stateCodeFor } = require('../src/api/invoicing/taxDetermination');

const PASSWORD = 'password123';
let adminCookie;
let tenantId;
let factory;
let bagUom;
let kgUom;
let tonneUom;
let cement;
let block;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const runInTenantContext = (fn) => {
  const session = cls.getNamespace(NAMESPACE_NAME) || cls.createNamespace(NAMESPACE_NAME);
  return session.runAndReturn(() => {
    session.set('tenantId', tenantId);
    return fn();
  });
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-adv', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@adv-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Adv Factory', code: 'ADV-FAC', state: 'Odisha' });

  bagUom = await Uom.create({ tenantId, name: 'Bag', code: 'BAG' });
  kgUom = await Uom.create({ tenantId, name: 'Kilogram', code: 'KG' });
  tonneUom = await Uom.create({ tenantId, name: 'Tonne', code: 'TONNE' });

  cement = await Product.create({ tenantId, uomId: kgUom.id, name: 'Cement', code: 'RM-CEM-ADV', productType: 'RAW_MATERIAL', standardCostPaise: 800 });
  block = await Product.create({ tenantId, uomId: kgUom.id, name: 'Paver Block', code: 'FG-BLK-ADV', productType: 'FINISHED_GOOD', curingDays: 14 });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@adv-test.co', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('FR-M03-2 UoM conversions', () => {
  it('creates a conversion and applies it in both directions', async () => {
    const created = await request(app)
      .post('/api/v1/uom-conversions')
      .set('Cookie', adminCookie)
      .send({ fromUomId: bagUom.id, toUomId: kgUom.id, factor: 50 });
    expect(created.status).toBe(201);

    // 1 Bag = 50 Kg
    const forward = await request(app)
      .get(`/api/v1/uom-convert?quantity=2&fromUomId=${bagUom.id}&toUomId=${kgUom.id}`)
      .set('Cookie', adminCookie);
    expect(forward.body.data.converted).toBe(100);

    // ...and the inverse is derived, not separately defined.
    const backward = await request(app)
      .get(`/api/v1/uom-convert?quantity=100&fromUomId=${kgUom.id}&toUomId=${bagUom.id}`)
      .set('Cookie', adminCookie);
    expect(backward.body.data.converted).toBe(2);
  });

  it('refuses a duplicate pair defined in either direction', async () => {
    const reverse = await request(app)
      .post('/api/v1/uom-conversions')
      .set('Cookie', adminCookie)
      .send({ fromUomId: kgUom.id, toUomId: bagUom.id, factor: 0.02 });
    expect(reverse.status).toBe(400);
  });

  it('refuses a self-conversion and a non-positive factor', async () => {
    const self = await request(app).post('/api/v1/uom-conversions').set('Cookie', adminCookie)
      .send({ fromUomId: kgUom.id, toUomId: kgUom.id, factor: 1 });
    expect(self.status).toBe(400);

    const zero = await request(app).post('/api/v1/uom-conversions').set('Cookie', adminCookie)
      .send({ fromUomId: tonneUom.id, toUomId: kgUom.id, factor: 0 });
    expect(zero.status).toBe(400);
  });

  it('resolves a one-hop conversion through a shared unit', async () => {
    // 1 Tonne = 1000 Kg, and 1 Bag = 50 Kg is already defined, so
    // Tonne -> Bag should resolve via Kg without being defined directly.
    await request(app).post('/api/v1/uom-conversions').set('Cookie', adminCookie)
      .send({ fromUomId: tonneUom.id, toUomId: kgUom.id, factor: 1000 });

    const hop = await runInTenantContext(() => UomService.convert(1, tonneUom.id, bagUom.id));
    expect(hop).toBe(20); // 1000 Kg / 50 Kg per bag
  });

  it('reports a clear error when no route exists', async () => {
    const orphan = await Uom.create({ tenantId, name: 'Litre', code: 'LTR' });
    await expect(runInTenantContext(() => UomService.convert(1, orphan.id, kgUom.id))).rejects.toThrow(/No conversion is defined/);
  });
});

describe('AC-2.1 BOM versioning resolves by production date', () => {
  it('uses the version in force on the date, not the currently-active one', async () => {
    // v1 effective 01-Apr, v2 effective 01-May.
    const v1 = await request(app).post('/api/v1/mix-designs').set('Cookie', adminCookie).send({
      productId: block.id, name: 'Mix v1', activate: true, effectiveFrom: '2026-04-01',
      lines: [{ rawMaterialProductId: cement.id, quantityPerUnit: 2, uomId: kgUom.id }],
    });
    expect(v1.body.data.status).toBe('ACTIVE');

    const v2 = await request(app).post('/api/v1/mix-designs').set('Cookie', adminCookie).send({
      productId: block.id, name: 'Mix v2',
      lines: [{ rawMaterialProductId: cement.id, quantityPerUnit: 3, uomId: kgUom.id }],
    });
    await request(app).put(`/api/v1/mix-designs/${v2.body.data.id}/activate`).set('Cookie', adminCookie)
      .send({ effectiveFrom: '2026-05-01' });

    // A production date in April must still resolve v1, even though v2 is now
    // the active version — this is what keeps April's entries explainable.
    const inApril = await runInTenantContext(() => BomService.resolveForDate(block.id, '2026-04-10'));
    expect(inApril.id).toBe(v1.body.data.id);
    expect(Number(inApril.lines[0].quantityPerUnit)).toBe(2);

    const inMay = await runInTenantContext(() => BomService.resolveForDate(block.id, '2026-05-05'));
    expect(inMay.id).toBe(v2.body.data.id);
    expect(Number(inMay.lines[0].quantityPerUnit)).toBe(3);
  });

  it('explodes a BOM including wastage and converts into the stocking unit', async () => {
    const bagFed = await Product.create({
      tenantId, uomId: kgUom.id, name: 'Bagged Cement', code: 'RM-BAGCEM', productType: 'RAW_MATERIAL', standardCostPaise: 800,
    });
    const product = await Product.create({
      tenantId, uomId: kgUom.id, name: 'Wastage Block', code: 'FG-WASTE', productType: 'FINISHED_GOOD',
    });

    // Line is written in BAGS but the material is stocked in KG, and carries
    // 10% wastage: 1 bag/unit * 10 units * 1.1 = 11 bags = 550 kg.
    const bom = await request(app).post('/api/v1/mix-designs').set('Cookie', adminCookie).send({
      productId: product.id, name: 'Bag Mix', activate: true,
      lines: [{ rawMaterialProductId: bagFed.id, quantityPerUnit: 1, uomId: bagUom.id, wastagePercent: 10 }],
    });

    const exploded = await request(app)
      .get(`/api/v1/mix-designs/${bom.body.data.id}/explode?outputQty=10`)
      .set('Cookie', adminCookie);
    expect(exploded.status).toBe(200);

    const line = exploded.body.data.requirements[0];
    expect(line.bomQuantity).toBe(10);
    expect(line.quantity).toBe(550); // 11 bags converted to kg
    expect(line.convertedFromUomId).toBe(bagUom.id);
  });

  it('rolls up material cost per output unit', async () => {
    const list = await request(app).get(`/api/v1/mix-designs?productId=${block.id}`).set('Cookie', adminCookie);
    const active = list.body.data.rows.find((b) => b.status === 'ACTIVE');

    const cost = await request(app).get(`/api/v1/mix-designs/${active.id}/cost`).set('Cookie', adminCookie);
    expect(cost.status).toBe(200);
    // v2 is active: 3 kg of cement at 800 paise/kg.
    expect(cost.body.data.totalCostPaise).toBe(2400);
  });
});

describe('AC-9.1 Tax determination follows the shipping address', () => {
  it('maps state names and GSTIN prefixes to codes', () => {
    expect(stateCodeFor('Odisha')).toBe('21');
    expect(stateCodeFor('ODISHA')).toBe('21');
    expect(stateCodeFor('Orissa')).toBe('21'); // legacy name
    expect(stateCodeFor('West Bengal')).toBe('19');
    expect(stateCodeFor('21')).toBe('21');
    expect(stateCodeFor('Atlantis')).toBeNull();
  });

  it.each([
    ['21', ['CGST', 'SGST']],
    ['19', ['IGST']],
    ['27', ['IGST']],
  ])('supplier in Odisha shipping to %s applies %s', (pos, heads) => {
    const result = determineTax({
      factory: { state: 'Odisha' },
      shippingAddress: { stateCode: pos },
      customer: {},
    });
    expect(result.heads).toEqual(heads);
    expect(result.isInterState).toBe(heads[0] === 'IGST');
  });

  it('prefers the shipping address over the customer’s registered state', () => {
    // A Delhi-registered customer taking delivery in Odisha is an INTRA-state
    // supply — using the customer's own state here would misfile the return.
    const result = determineTax({
      factory: { state: 'Odisha' },
      shippingAddress: { state: 'Odisha' },
      customer: { state: 'Delhi', gstin: '07AAAAA0000A1Z5' },
    });
    expect(result.isInterState).toBe(false);
    expect(result.heads).toEqual(['CGST', 'SGST']);
  });

  it('falls back to the customer when there is no shipping address', () => {
    const result = determineTax({
      factory: { state: 'Odisha' },
      shippingAddress: null,
      customer: { state: 'West Bengal' },
    });
    expect(result.isInterState).toBe(true);
  });

  it('refuses to guess when the place of supply is unknown', () => {
    expect(() => determineTax({ factory: { state: 'Odisha' }, shippingAddress: null, customer: {} }))
      .toThrow(/place of supply/i);
  });
});

describe('FR-M04-2 Party addresses', () => {
  // Each case creates its own customer rather than sharing one across `it`
  // blocks: carrying a row id between tests couples them to each other's
  // success and to whatever else touched the table in between.
  const newCustomer = (name) => Party.create({ tenantId, partyType: 'CUSTOMER', name });

  it('makes the first address the default for both kinds', async () => {
    const customer = await newCustomer('Address Test Co');

    const created = await request(app)
      .post(`/api/v1/parties/${customer.id}/addresses`)
      .set('Cookie', adminCookie)
      .send({ label: 'Head Office', line1: '1 Main Road', city: 'Bhubaneswar', state: 'Odisha' });

    expect(created.status).toBe(201);
    expect(created.body.data.isDefaultBilling).toBe(true);
    expect(created.body.data.isDefaultShipping).toBe(true);
    // The state code is derived — tax logic compares codes, not free text.
    expect(created.body.data.stateCode).toBe('21');
  });

  it('moves the default when a second address claims it', async () => {
    const customer = await newCustomer('Default Move Co');

    const first = await request(app)
      .post(`/api/v1/parties/${customer.id}/addresses`)
      .set('Cookie', adminCookie)
      .send({ label: 'Head Office', line1: '1 Main Road', state: 'Odisha' });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post(`/api/v1/parties/${customer.id}/addresses`)
      .set('Cookie', adminCookie)
      .send({ label: 'Site', line1: '9 Site Road', state: 'West Bengal', isDefaultShipping: true });
    expect(second.status).toBe(201);
    expect(second.body.data.stateCode).toBe('19');

    const all = await request(app).get(`/api/v1/parties/${customer.id}/addresses`).set('Cookie', adminCookie);
    const defaults = all.body.data.filter((a) => a.isDefaultShipping);
    expect(defaults).toHaveLength(1);
    expect(defaults[0].label).toBe('Site');
  });
});
