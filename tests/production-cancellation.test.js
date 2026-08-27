/**
 * Regression cover for the production and wastage fixes:
 *
 *   PRD-01  a posted casting run can be cancelled, reversing BOTH stock legs
 *   PRD-02  the mix design in force on a date is resolvable over the API, so a
 *           screen can show the same recipe the posting code will consume
 *   PRD-03  insufficient raw material is reported for every short material at
 *           once, before anything is consumed
 *   WST-01  a wastage movement references the wastage record that caused it
 *   WST-02  wastage always moves stock — a lot is required
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product,
  MixDesign, MixDesignLine, StockLedgerEntry, WastageRecord, Party,
} = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;
let factory;
let cement;
let sand;
let slab;
let vendor;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

/**
 * Puts `qty` of a product into stock through the goods-receipt API, which is
 * how stock legitimately comes into existence — going straight at StockLot
 * would bypass tenant context and the ledger.
 */
const stockIn = async (productId, qty) => {
  const res = await request(app)
    .post('/api/v1/purchasing/receipts')
    .set('Cookie', adminCookie)
    .send({
      factoryId: factory.id,
      vendorPartyId: vendor.id,
      receiptDate: '2026-04-01',
      lines: [{ productId, receivedQty: qty, ratePaise: 5000 }],
    });
  expect(res.status).toBe(201);
  return res.body.data;
};

const balance = async (productId) => {
  const res = await request(app)
    .get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${productId}`)
    .set('Cookie', adminCookie);
  return Number(res.body.data.balance ?? res.body.data.total ?? res.body.data);
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Cancel Co', slug: 'cancel-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Cancel Co Ltd', code: 'CC' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@cancel.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Cancel Factory', code: 'CC-FAC', varianceThresholdPercent: 5 });

  vendor = await Party.create({ tenantId, name: 'Cancel Vendor', code: 'V-CC', partyType: 'VENDOR', status: 'active' });
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-CC' });
  cement = await Product.create({ tenantId, uomId: uom.id, name: 'Cement CC', code: 'RM-CEM-CC', productType: 'RAW_MATERIAL', curingDays: 0 });
  sand = await Product.create({ tenantId, uomId: uom.id, name: 'Sand CC', code: 'RM-SAND-CC', productType: 'RAW_MATERIAL', curingDays: 0 });
  // curingDays 0 so the produced lot is AVAILABLE immediately and the
  // "already dispatched" guard can be exercised without waiting on a clock.
  slab = await Product.create({ tenantId, uomId: uom.id, name: 'Slab CC', code: 'FG-SLAB-CC', productType: 'FINISHED_GOOD', curingDays: 0 });

  // Two recipe versions for the same product, so "which recipe on which date"
  // has a real answer to test.
  const v1 = await MixDesign.create({
    tenantId, productId: slab.id, name: 'Slab CC v1', version: 1,
    status: 'SUPERSEDED', isActive: false, effectiveFrom: '2026-04-01',
  });
  await MixDesignLine.create({ tenantId, mixDesignId: v1.id, rawMaterialProductId: cement.id, quantityPerUnit: 2, uomId: uom.id });

  const v2 = await MixDesign.create({
    tenantId, productId: slab.id, name: 'Slab CC v2', version: 2,
    status: 'ACTIVE', isActive: true, effectiveFrom: '2026-08-01',
  });
  await MixDesignLine.create({ tenantId, mixDesignId: v2.id, rawMaterialProductId: cement.id, quantityPerUnit: 2, uomId: uom.id });
  await MixDesignLine.create({ tenantId, mixDesignId: v2.id, rawMaterialProductId: sand.id, quantityPerUnit: 3, uomId: uom.id });

  adminCookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@cancel.co', password: PASSWORD }),
    'accessToken'
  );
});

afterAll(async () => {
  await sequelize.close();
});

describe('PRD-02 — the mix design in force on a date is resolvable over the API', () => {
  it('returns the older recipe for a date before the new one took effect', async () => {
    const res = await request(app)
      .get(`/api/v1/mix-designs/resolve?productId=${slab.id}&onDate=2026-06-15`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(1);
    expect(res.body.data.lines).toHaveLength(1);
  });

  it('returns the current recipe for a date after it took effect', async () => {
    const res = await request(app)
      .get(`/api/v1/mix-designs/resolve?productId=${slab.id}&onDate=2026-08-20`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.version).toBe(2);
    expect(res.body.data.lines).toHaveLength(2);
  });

  it('agrees with what production actually consumes on that date', async () => {
    await stockIn(cement.id, 100);
    const res = await request(app)
      .post('/api/v1/production/entries')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, productId: slab.id, productionDate: '2026-06-15', goodQty: 5 });

    expect(res.status).toBe(201);
    // v1 has cement only, so exactly one consumption — not v2's two.
    expect(res.body.data.consumptions).toHaveLength(1);
    expect(Number(res.body.data.consumptions[0].mixDesignQty)).toBe(10);
  });
});

describe('PRD-03 — insufficient material is reported in full, before anything moves', () => {
  it('names every short material in one error and consumes nothing', async () => {
    const cementBefore = await balance(cement.id);

    const res = await request(app)
      .post('/api/v1/production/entries')
      .set('Cookie', adminCookie)
      // v2 (2026-08-20) needs cement AND sand; no sand has ever been received.
      .send({ factoryId: factory.id, productId: slab.id, productionDate: '2026-08-20', goodQty: 1000 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Cement CC/);
    expect(res.body.message).toMatch(/Sand CC/);
    expect(res.body.message).toMatch(/2 materials short/);

    // Nothing was consumed on the way to discovering the shortage.
    expect(await balance(cement.id)).toBe(cementBefore);
  });
});

describe('PRD-01 — cancelling a production entry reverses both stock legs', () => {
  let entry;
  let cementBefore;

  it('posts a run that consumes raw material and creates finished goods', async () => {
    await stockIn(sand.id, 100);
    cementBefore = await balance(cement.id);

    const res = await request(app)
      .post('/api/v1/production/entries')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, productId: slab.id, productionDate: '2026-08-20', goodQty: 10 });

    expect(res.status).toBe(201);
    entry = res.body.data;
    expect(await balance(cement.id)).toBe(cementBefore - 20); // 2 per unit
    expect(await balance(slab.id)).toBeGreaterThanOrEqual(10);
  });

  it('refuses to cancel without a reason', async () => {
    const res = await request(app)
      .put(`/api/v1/production/entries/${entry.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({});
    expect(res.status).toBe(400);
  });

  it('returns the raw material and removes the finished goods', async () => {
    const slabBefore = await balance(slab.id);

    const res = await request(app)
      .put(`/api/v1/production/entries/${entry.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Keyed against the wrong product' });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');

    expect(await balance(cement.id)).toBe(cementBefore); // cement handed back
    expect(await balance(slab.id)).toBe(slabBefore - 10); // slabs withdrawn
  });

  it('keeps the record and its number rather than deleting it (BR-33)', async () => {
    const res = await request(app).get(`/api/v1/production/entries/${entry.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.entryNumber).toBe(entry.entryNumber);
    expect(res.body.data.cancelReason).toBe('Keyed against the wrong product');
  });

  it('refuses to cancel the same entry twice', async () => {
    const res = await request(app)
      .put(`/api/v1/production/entries/${entry.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Again' });
    expect(res.status).toBe(400);
  });

  it('leaves the ledger and the lot balances in agreement', async () => {
    const { StockLedgerService } = require('../src/api/inventory/stockLedger.service');
    const { discrepancies } = await StockLedgerService.reconcileLedgerVsBalances({ factoryId: factory.id });
    expect(discrepancies).toEqual([]);
  });
});

describe('PRD-01 — cancellation is refused once the output has left the lot', () => {
  it('blocks the cancel and explains why', async () => {
    const created = await request(app)
      .post('/api/v1/production/entries')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, productId: slab.id, productionDate: '2026-08-20', goodQty: 4 });
    expect(created.status).toBe(201);

    // Take some of the run's output back out of stock.
    const wastage = await request(app)
      .post('/api/v1/production/wastage')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id, productId: slab.id, lotId: created.body.data.lotId,
        stage: 'HANDLING', quantity: 1, reason: 'Dropped', recordedDate: '2026-08-21',
      });
    expect(wastage.status).toBe(201);

    const res = await request(app)
      .put(`/api/v1/production/entries/${created.body.data.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Too late' });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/already left lot/i);
  });
});

describe('WST-01 / WST-02 — wastage is traceable and always moves stock', () => {
  it('refuses wastage with no lot rather than silently leaving stock untouched', async () => {
    const res = await request(app)
      .post('/api/v1/production/wastage')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id, productId: cement.id,
        stage: 'STACKING', quantity: 1, reason: 'No lot given', recordedDate: '2026-08-21',
      });
    expect(res.status).toBe(400);
  });

  it('points the stock movement at the wastage record that caused it', async () => {
    const receipt = await stockIn(cement.id, 50);
    const lotId = receipt.lines[0].lotId;

    const res = await request(app)
      .post('/api/v1/production/wastage')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id, productId: cement.id, lotId,
        stage: 'STACKING', quantity: 2, reason: 'Bag torn', recordedDate: '2026-08-21',
      });
    expect(res.status).toBe(201);

    const recordId = res.body.data.id;
    const movement = await StockLedgerEntry.findOne({
      where: { referenceType: 'WastageRecord', referenceId: recordId, movementType: 'BREAKAGE_OUT' },
    });

    // The movement must resolve to a real wastage record — the whole point of
    // WST-01, where referenceId used to be a UUID that matched nothing.
    expect(movement).not.toBeNull();
    expect(Number(movement.quantity)).toBe(2);
    expect(await WastageRecord.findByPk(recordId)).not.toBeNull();
  });
});
