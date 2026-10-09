const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party, MixDesign,
  AdGroup, AdGroupMember, UserFactory, StockLot, ProductionPlan, ProductionEntry,
  MaterialConsumption, Cheque, QualityInspection,
} = require('../src/models/index');

/**
 * BR-29 on single records.
 *
 * enforceFactoryScope only sees a factoryId the caller names. A handler that
 * loads a record by `:id` has to check the record's own plant, or a user at
 * Plant A can read — and act on — Plant B's documents by id. Each case here
 * proves the Plant A user gets a 404 for Plant B's record, that the record is
 * untouched afterwards, and that the same user still reaches Plant A's.
 */

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

let X;
let plantAOnly;

const as = (cookie) => ({
  get: (p) => request(app).get(p).set('Cookie', cookie),
  put: (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {}),
});

// One of each record, at a given plant.
const seedAt = async (factory, tag) => {
  const { tenantId, product, finishedGood, mix, customer } = X;
  const lot = await StockLot.create({
    tenantId, factoryId: factory.id, productId: finishedGood.id, lotNumber: `LOT-${tag}`,
    originType: 'PRODUCTION', originId: factory.id, originDate: '2026-08-01',
    curingDays: 7, status: 'CURING', qtyOriginal: 10, qtyAvailable: 10,
  });
  const plan = await ProductionPlan.create({ tenantId, factoryId: factory.id, planDate: '2026-08-01', planNumber: `PP-${tag}` });
  const entry = await ProductionEntry.create({
    tenantId, factoryId: factory.id, entryNumber: `PE-${tag}`, productId: finishedGood.id, mixDesignId: mix.id,
    productionDate: '2026-08-01', goodQty: 10, rejectedQty: 0, curingDays: 7, lotId: lot.id,
  });
  const consumption = await MaterialConsumption.create({
    tenantId, productionEntryId: entry.id, rawMaterialProductId: product.id,
    mixDesignQty: 10, actualQty: 12, variancePercent: 20, requiresApproval: true,
  });
  const cheque = await Cheque.create({
    tenantId, factoryId: factory.id, direction: 'INBOUND', partyId: customer.id,
    chequeNumber: `CHQ-${tag}`, chequeDate: '2026-08-01', amountPaise: 10000,
  });
  const inspection = await QualityInspection.create({
    tenantId, factoryId: factory.id, inspectionNumber: `QC-${tag}`, inspectionType: 'FINAL',
    productId: finishedGood.id, lotId: lot.id, inspectionDate: '2026-08-01',
  });
  return { lot, plan, entry, consumption, cheque, inspection };
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Scope Co', slug: 'scope-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Scope Pvt Ltd', code: 'SC' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const plantA = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant A', code: 'PA', state: 'Odisha' });
  const plantB = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant B', code: 'PB', state: 'Odisha' });
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  const product = await Product.create({ tenantId, uomId: uom.id, name: 'Cement', code: 'RM-1', productType: 'RAW_MATERIAL' });
  const finishedGood = await Product.create({ tenantId, uomId: uom.id, name: 'Paver', code: 'FG-1', productType: 'FINISHED_GOOD' });
  const mix = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Scope Customer', state: 'Odisha' });

  X = { tenantId, plantA, plantB, product, finishedGood, mix, customer };
  X.A = await seedAt(plantA, 'A');
  X.B = await seedAt(plantB, 'B');

  const u = await User.create(
    { tenantId, email: 'planta@scope.test', passwordHash, firstName: 'P', lastName: 'A', role: 'EMPLOYEE', status: 'ACTIVE' },
    { validate: false }
  );
  const g = await AdGroup.create({
    tenantId,
    name: 'Plant A staff',
    permissions: [
      'PRODUCTION_READ', 'PRODUCTION_MODIFY', 'PRODUCTION_DELETE', 'PRODUCTION_APPROVE_VARIANCE',
      // Cheque cancel has its own grant since PAYMENT_CANCEL was split out.
      'PAYMENT_READ', 'PAYMENT_MODIFY', 'PAYMENT_CANCEL', 'QUALITY_READ', 'QUALITY_MODIFY', 'OVERRIDE_CURING',
    ],
  });
  await AdGroupMember.create({ tenantId, adGroupId: g.id, employeeId: u.id });
  await UserFactory.create({ tenantId, userId: u.id, factoryId: plantA.id });
  plantAOnly = await loginAs('planta@scope.test');
});

afterAll(async () => {
  await sequelize.close();
});

describe('BR-29: records loaded by id are scoped to the caller\'s plants', () => {
  it('hides another plant\'s production plan, entry and consumption, and refuses to act on them', async () => {
    const { plan, entry, consumption } = X.B;
    expect((await as(plantAOnly).get(`/api/v1/production/plans/${plan.id}`)).status).toBe(404);
    expect((await as(plantAOnly).put(`/api/v1/production/plans/${plan.id}/confirm`, { lines: [] })).status).toBe(404);
    expect((await as(plantAOnly).get(`/api/v1/production/entries/${entry.id}`)).status).toBe(404);
    expect((await as(plantAOnly).put(`/api/v1/production/entries/${entry.id}/cancel`, { reason: 'Not mine to cancel' })).status).toBe(404);
    expect((await as(plantAOnly).put(`/api/v1/production/consumptions/${consumption.id}/approve`)).status).toBe(404);

    await Promise.all([plan.reload(), entry.reload(), consumption.reload()]);
    expect(plan.status).toBe('PROPOSED');
    expect(entry.status).toBe('POSTED');
    expect(consumption.approvedBy).toBeNull();
  });

  it('still serves the caller\'s own plant\'s production records', async () => {
    const plan = await as(plantAOnly).get(`/api/v1/production/plans/${X.A.plan.id}`);
    expect(plan.status).toBe(200);
    expect(plan.body.data.id).toBe(X.A.plan.id);

    const entry = await as(plantAOnly).get(`/api/v1/production/entries/${X.A.entry.id}`);
    expect(entry.status).toBe(200);
    expect(entry.body.data.id).toBe(X.A.entry.id);

    const approve = await as(plantAOnly).put(`/api/v1/production/consumptions/${X.A.consumption.id}/approve`);
    expect(approve.status).toBe(200);
  });

  it('hides another plant\'s cheque and refuses every lifecycle action on it', async () => {
    const { cheque } = X.B;
    expect((await as(plantAOnly).get(`/api/v1/cheques/${cheque.id}`)).status).toBe(404);
    expect((await as(plantAOnly).put(`/api/v1/cheques/${cheque.id}/present`, {})).status).toBe(404);
    expect((await as(plantAOnly).put(`/api/v1/cheques/${cheque.id}/clear`, {})).status).toBe(404);
    expect((await as(plantAOnly).put(`/api/v1/cheques/${cheque.id}/cancel`, { reason: 'Not mine to cancel' })).status).toBe(404);

    await cheque.reload();
    expect(cheque.status).toBe('ISSUED');
  });

  it('still serves and acts on the caller\'s own plant\'s cheque', async () => {
    const got = await as(plantAOnly).get(`/api/v1/cheques/${X.A.cheque.id}`);
    expect(got.status).toBe(200);
    expect(got.body.data.id).toBe(X.A.cheque.id);

    const presented = await as(plantAOnly).put(`/api/v1/cheques/${X.A.cheque.id}/present`, {});
    expect(presented.status).toBe(200);
    expect(presented.body.data.status).toBe('PRESENTED');
  });

  it('hides another plant\'s quality inspection and refuses to record its result', async () => {
    const { inspection } = X.B;
    expect((await as(plantAOnly).get(`/api/v1/quality/${inspection.id}`)).status).toBe(404);
    expect((await as(plantAOnly).put(`/api/v1/quality/${inspection.id}/result`, { result: 'FAIL' })).status).toBe(404);

    await inspection.reload();
    expect(inspection.result).toBe('PENDING');

    const own = await as(plantAOnly).get(`/api/v1/quality/${X.A.inspection.id}`);
    expect(own.status).toBe(200);
    expect(own.body.data.id).toBe(X.A.inspection.id);
  });

  it('refuses to release another plant\'s curing lot early, but releases its own', async () => {
    const { lot } = X.B;
    const res = await as(plantAOnly).put(`/api/v1/inventory/lots/${lot.id}/release-early`, { reason: 'Customer is waiting' });
    expect(res.status).toBe(404);
    await lot.reload();
    expect(lot.status).toBe('CURING');

    const own = await as(plantAOnly).put(`/api/v1/inventory/lots/${X.A.lot.id}/release-early`, { reason: 'Customer is waiting' });
    expect(own.status).toBe(200);
    expect(own.body.data.status).toBe('AVAILABLE');
  });
});
