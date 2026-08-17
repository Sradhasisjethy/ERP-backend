const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, AdGroup, AdGroupMember, AuditLog } = require('../src/models/index');
const { WebPermissions } = require('../src/utils/constants');

const PASSWORD = 'password123';
let adminCookie;
let limitedCookie;
let tenantId;
let organizationId;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const loginAs = async (email) => {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return extractCookie(res, 'accessToken');
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-precast', status: 'active' });
  tenantId = tenant.id;

  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  organizationId = org.id;

  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  await User.create(
    {
      tenantId,
      email: 'admin@bhuasuni.test',
      passwordHash,
      firstName: 'Admin',
      lastName: 'User',
      role: 'PLATFORM_ADMIN',
    },
    { validate: false }
  );

  // A limited user with PRODUCT_READ/WRITE and PARTY_READ but no VIEW_RATES —
  // used to prove BR-27 field masking actually strips rate fields server-side.
  const limitedUser = await User.create(
    {
      tenantId,
      email: 'storekeeper@bhuasuni.test',
      passwordHash,
      firstName: 'Store',
      lastName: 'Keeper',
      role: 'EMPLOYEE',
    },
    { validate: false }
  );

  const limitedGroup = await AdGroup.create({
    tenantId,
    name: 'Store Keeper',
    permissions: [
      WebPermissions.PRODUCT_READ,
      WebPermissions.PRODUCT_WRITE,
      WebPermissions.PARTY_READ,
      WebPermissions.PRICING_READ,
    ],
  });
  await AdGroupMember.create({ tenantId, adGroupId: limitedGroup.id, employeeId: limitedUser.id });

  adminCookie = await loginAs('admin@bhuasuni.test');
  limitedCookie = await loginAs('storekeeper@bhuasuni.test');
});

afterAll(async () => {
  await sequelize.close();
});

describe('Factory & Financial Year (M01, BR-29)', () => {
  let factoryId;

  it('creates a factory with the tenant auto-assigned', async () => {
    const res = await request(app)
      .post('/api/v1/factories')
      .set('Cookie', adminCookie)
      .send({ organizationId, name: 'Bhubaneswar Plant', code: 'BBSR' });

    expect(res.status).toBe(201);
    expect(res.body.data.tenantId).toBeTruthy();
    factoryId = res.body.data.id;
  });

  it('creates and reads back the current financial year', async () => {
    const create = await request(app)
      .post('/api/v1/financial-years')
      .set('Cookie', adminCookie)
      .send({ code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31' });
    expect(create.status).toBe(201);

    await request(app).put(`/api/v1/financial-years/${create.body.data.id}/set-current`).set('Cookie', adminCookie);

    const current = await request(app).get('/api/v1/financial-years/current').set('Cookie', adminCookie);
    expect(current.status).toBe(200);
    expect(current.body.data.isCurrent).toBe(true);
  });

  it('assigns a user to a factory and rejects a duplicate assignment', async () => {
    const limited = await User.findOne({ where: { email: 'storekeeper@bhuasuni.test' } });

    const assign = await request(app)
      .post(`/api/v1/factories/${factoryId}/users`)
      .set('Cookie', adminCookie)
      .send({ userId: limited.id });
    expect(assign.status).toBe(201);

    const duplicate = await request(app)
      .post(`/api/v1/factories/${factoryId}/users`)
      .set('Cookie', adminCookie)
      .send({ userId: limited.id });
    expect(duplicate.status).toBe(409);
  });

  it('records an audit log entry for the factory create (BR-30)', async () => {
    const logs = await AuditLog.findAll({ where: { entityType: 'Factory', entityId: factoryId } });
    expect(logs.length).toBeGreaterThan(0);
    expect(logs[0].action).toBe('CREATE');
    expect(logs[0].afterSnapshot.code).toBe('BBSR');
  });
});

describe('Document numbering (M16, BR-31/BR-32)', () => {
  it('allocates gap-free, incrementing numbers for the same series', async () => {
    const { DocumentNumberingService } = require('../src/api/documentSeries/documentNumbering.service');
    const { getTenantContext } = require('../src/core/tenantContext');
    const cls = require('cls-hooked');
    const { NAMESPACE_NAME } = require('../src/core/tenantContext');

    const fy = await require('../src/models/index').FinancialYear.findOne({ where: { tenantId } });

    const runInTenantContext = (fn) => {
      const session = cls.getNamespace(NAMESPACE_NAME) || cls.createNamespace(NAMESPACE_NAME);
      return session.runAndReturn(() => {
        session.set('tenantId', tenantId);
        return fn();
      });
    };

    const first = await runInTenantContext(() =>
      DocumentNumberingService.allocate('TEST_DOC', { financialYearId: fy.id, prefix: 'TST' })
    );
    const second = await runInTenantContext(() =>
      DocumentNumberingService.allocate('TEST_DOC', { financialYearId: fy.id, prefix: 'TST' })
    );

    expect(first.sequenceNumber).toBe(1);
    expect(second.sequenceNumber).toBe(2);
    expect(first.documentNumber).toBe('TST/0001');
    expect(second.documentNumber).toBe('TST/0002');
    expect(getTenantContext()).toBeTruthy();
  });
});

describe('Product / BOM masters (M03, BR-06)', () => {
  let uomId;
  let productId;

  it('creates a UoM and a product referencing it', async () => {
    const uom = await request(app).post('/api/v1/uoms').set('Cookie', adminCookie).send({ name: 'Numbers', code: 'NOS' });
    expect(uom.status).toBe(201);
    uomId = uom.body.data.id;

    const product = await request(app)
      .post('/api/v1/products')
      .set('Cookie', adminCookie)
      .send({ name: 'Precast Slab', code: 'FG-SLAB', uomId, curingDays: 14, standardCostPaise: 45000 });
    expect(product.status).toBe(201);
    productId = product.body.data.id;
  });

  it('masks standardCostPaise for a user without VIEW_RATES (BR-27)', async () => {
    const res = await request(app).get(`/api/v1/products/${productId}`).set('Cookie', limitedCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.standardCostPaise).toBeNull();
    expect(res.body.data.name).toBe('Precast Slab');
  });

  it('returns the real standardCostPaise for the admin (bypass role)', async () => {
    const res = await request(app).get(`/api/v1/products/${productId}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.standardCostPaise).toBe('45000');
  });

  it('creating a second active mix design deactivates the first (only one active per product)', async () => {
    const cementUom = await request(app).post('/api/v1/uoms').set('Cookie', adminCookie).send({ name: 'Bag', code: 'BAG' });
    const cement = await request(app)
      .post('/api/v1/products')
      .set('Cookie', adminCookie)
      .send({ name: 'Cement', code: 'RM-CEMENT', uomId: cementUom.body.data.id, productType: 'RAW_MATERIAL' });

    // FR-M03-6: a new version starts as a DRAFT and does not affect production
    // until activated. `activate: true` does both in one step.
    const mix1 = await request(app)
      .post('/api/v1/mix-designs')
      .set('Cookie', adminCookie)
      .send({
        productId,
        name: 'Mix v1',
        activate: true,
        effectiveFrom: '2026-04-01',
        lines: [{ rawMaterialProductId: cement.body.data.id, quantityPerUnit: 0.5, uomId: cementUom.body.data.id }],
      });
    expect(mix1.status).toBe(201);
    expect(mix1.body.data.status).toBe('ACTIVE');
    expect(mix1.body.data.version).toBe(1);

    // A second version starts as a draft — activating it is a separate decision.
    const mix2 = await request(app)
      .post('/api/v1/mix-designs')
      .set('Cookie', adminCookie)
      .send({
        productId,
        name: 'Mix v2',
        lines: [{ rawMaterialProductId: cement.body.data.id, quantityPerUnit: 0.6, uomId: cementUom.body.data.id }],
      });
    expect(mix2.status).toBe(201);
    expect(mix2.body.data.status).toBe('DRAFT');
    expect(mix2.body.data.version).toBe(2);

    // v1 is untouched while v2 is still a draft.
    const v1WhileDraft = await request(app).get(`/api/v1/mix-designs/${mix1.body.data.id}`).set('Cookie', adminCookie);
    expect(v1WhileDraft.body.data.status).toBe('ACTIVE');

    // FR-M03-8: activating v2 supersedes v1 and links the two.
    const activated = await request(app)
      .put(`/api/v1/mix-designs/${mix2.body.data.id}/activate`)
      .set('Cookie', adminCookie)
      .send({ effectiveFrom: '2026-05-01' });
    expect(activated.status).toBe(200);
    expect(activated.body.data.status).toBe('ACTIVE');

    const supersededV1 = await request(app).get(`/api/v1/mix-designs/${mix1.body.data.id}`).set('Cookie', adminCookie);
    expect(supersededV1.body.data.status).toBe('SUPERSEDED');
    expect(supersededV1.body.data.isActive).toBe(false);
    expect(supersededV1.body.data.supersededByMixDesignId).toBe(mix2.body.data.id);

    // FR-M03-9: superseded versions are never deleted — history must remain
    // explainable — and stay viewable.
    const deleteAttempt = await request(app).delete(`/api/v1/mix-designs/${mix1.body.data.id}`).set('Cookie', adminCookie);
    expect(deleteAttempt.status).toBe(400);
    const stillThere = await request(app).get(`/api/v1/mix-designs/${mix1.body.data.id}`).set('Cookie', adminCookie);
    expect(stillThere.status).toBe(200);

    // An ACTIVE/SUPERSEDED version can't be edited in place either.
    const editAttempt = await request(app)
      .put(`/api/v1/mix-designs/${mix1.body.data.id}`)
      .set('Cookie', adminCookie)
      .send({ name: 'Rewriting history' });
    expect(editAttempt.status).toBe(400);
  });
});

describe('Party masters (M04)', () => {
  it('creates a unified party of each type', async () => {
    const customer = await request(app)
      .post('/api/v1/parties')
      .set('Cookie', adminCookie)
      .send({ partyType: 'CUSTOMER', name: 'Kalinga Builders', creditLimitPaise: 1000000 });
    expect(customer.status).toBe(201);

    const labour = await request(app)
      .post('/api/v1/parties')
      .set('Cookie', adminCookie)
      .send({ partyType: 'LABOUR', name: 'Suresh Mallick' });
    expect(labour.status).toBe(201);

    const wageProfile = await request(app)
      .put(`/api/v1/parties/${labour.body.data.id}/wage-profile`)
      .set('Cookie', adminCookie)
      .send({ dailyWagePaise: 60000, overtimeRateMultiplier: 1.5 });
    expect(wageProfile.status).toBe(200);
  });

  it('rejects a wage profile on a non-LABOUR party', async () => {
    const vendor = await request(app)
      .post('/api/v1/parties')
      .set('Cookie', adminCookie)
      .send({ partyType: 'VENDOR', name: 'Odisha Cement Suppliers' });

    const res = await request(app)
      .put(`/api/v1/parties/${vendor.body.data.id}/wage-profile`)
      .set('Cookie', adminCookie)
      .send({ dailyWagePaise: 60000 });
    expect(res.status).toBe(400);
  });

  it('masks creditLimitPaise for a user without VIEW_RATES', async () => {
    const list = await request(app).get('/api/v1/parties').set('Cookie', limitedCookie);
    expect(list.status).toBe(200);
    const withCredit = list.body.data.rows.find((p) => p.creditLimitPaise !== null);
    expect(withCredit).toBeUndefined();
  });
});

describe('Pricing (M05, BR-27)', () => {
  it('creates a price list with items and masks rates for limited users', async () => {
    const uom = await request(app).post('/api/v1/uoms').set('Cookie', adminCookie).send({ name: 'Numbers2', code: 'NOS2' });
    const product = await request(app)
      .post('/api/v1/products')
      .set('Cookie', adminCookie)
      .send({ name: 'Precast Pillar', code: 'FG-PILLAR', uomId: uom.body.data.id });

    const priceList = await request(app)
      .post('/api/v1/price-lists')
      .set('Cookie', adminCookie)
      .send({
        name: 'Standard Retail',
        priceType: 'RETAIL',
        items: [{ productId: product.body.data.id, ratePaise: 65000 }],
      });
    expect(priceList.status).toBe(201);
    expect(priceList.body.data.items[0].ratePaise).toBe('65000');

    const asLimited = await request(app).get(`/api/v1/price-lists/${priceList.body.data.id}`).set('Cookie', limitedCookie);
    expect(asLimited.status).toBe(200);
    expect(asLimited.body.data.items[0].ratePaise).toBeNull();
  });
});
