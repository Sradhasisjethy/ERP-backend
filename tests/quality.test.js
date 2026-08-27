/**
 * QC-01 — quality control.
 *
 * The two gates, and the promise that neither exists until you ask for it:
 *
 *   incoming  a goods receipt splits into accepted and rejected; only the
 *             accepted quantity ever becomes stock
 *   final     a produced lot of a qcRequired product waits in QC_HOLD until a
 *             passing FINAL inspection releases it — no timer does it
 *
 * The last describe block is the important one for anyone who does not work
 * this way: with both switches off, behaviour is byte-identical to before.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product,
  MixDesign, MixDesignLine, Party, StockLot,
} = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;
let qcFactory;      // qcHoldEnabled = true
let plainFactory;   // qcHoldEnabled = false
let cement;
let slab;           // qcRequired = true
let plainSlab;      // qcRequired = false
let vendor;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const receive = (factoryId, lines) =>
  request(app).post('/api/v1/purchasing/receipts').set('Cookie', adminCookie)
    .send({ factoryId, vendorPartyId: vendor.id, receiptDate: '2026-04-01', lines });

const produce = (factoryId, productId, goodQty) =>
  request(app).post('/api/v1/production/entries').set('Cookie', adminCookie)
    .send({ factoryId, productId, productionDate: '2026-08-20', goodQty });

const availability = async (factoryId, productId) => {
  const res = await request(app)
    .get(`/api/v1/sales/atp?factoryId=${factoryId}&productId=${productId}`)
    .set('Cookie', adminCookie);
  return res.body.data;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'QC Co', slug: 'qc-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'QC Co Ltd', code: 'QC' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@qc.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  qcFactory = await Factory.create({ tenantId, organizationId: org.id, name: 'QC Plant', code: 'QC-FAC', varianceThresholdPercent: 5, qcHoldEnabled: true });
  plainFactory = await Factory.create({ tenantId, organizationId: org.id, name: 'Plain Plant', code: 'PL-FAC', varianceThresholdPercent: 5 });

  vendor = await Party.create({ tenantId, name: 'QC Vendor', code: 'V-QC', partyType: 'VENDOR', status: 'active' });
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-QC' });

  cement = await Product.create({ tenantId, uomId: uom.id, name: 'Cement QC', code: 'RM-CEM-QC', productType: 'RAW_MATERIAL', curingDays: 0 });
  // curingDays 0 on both, so the hold is unambiguously the QC gate and not the
  // curing clock doing the work.
  slab = await Product.create({ tenantId, uomId: uom.id, name: 'Slab QC', code: 'FG-SLAB-QC', productType: 'FINISHED_GOOD', curingDays: 0, qcRequired: true });
  plainSlab = await Product.create({ tenantId, uomId: uom.id, name: 'Slab Plain', code: 'FG-SLAB-PL', productType: 'FINISHED_GOOD', curingDays: 0 });

  for (const product of [slab, plainSlab]) {
    const md = await MixDesign.create({
      tenantId, productId: product.id, name: `${product.code} v1`, version: 1,
      status: 'ACTIVE', isActive: true, effectiveFrom: '2026-04-01',
    });
    await MixDesignLine.create({ tenantId, mixDesignId: md.id, rawMaterialProductId: cement.id, quantityPerUnit: 1, uomId: uom.id });
  }

  adminCookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@qc.co', password: PASSWORD }),
    'accessToken'
  );
});

afterAll(async () => {
  await sequelize.close();
});

describe('Incoming inspection — only accepted material becomes stock', () => {
  it('stocks the whole delivery when nothing is rejected', async () => {
    const res = await receive(qcFactory.id, [{ productId: cement.id, receivedQty: 100, ratePaise: 5000 }]);
    expect(res.status).toBe(201);
    expect(Number(res.body.data.lines[0].acceptedQty)).toBe(100);
    expect(Number(res.body.data.lines[0].rejectedQty)).toBe(0);

    const bal = await availability(qcFactory.id, cement.id);
    expect(Number(bal.onHand)).toBe(100);
  });

  it('stocks only the accepted quantity when some is turned away', async () => {
    const before = Number((await availability(qcFactory.id, cement.id)).onHand);

    const res = await receive(qcFactory.id, [
      { productId: cement.id, receivedQty: 40, rejectedQty: 3, rejectionReason: 'Bags wet on arrival', ratePaise: 5000 },
    ]);
    expect(res.status).toBe(201);
    expect(Number(res.body.data.lines[0].acceptedQty)).toBe(37);

    // The three rejected bags never became stock.
    const after = Number((await availability(qcFactory.id, cement.id)).onHand);
    expect(after).toBe(before + 37);
  });

  it('requires a reason for a rejection', async () => {
    const res = await receive(qcFactory.id, [{ productId: cement.id, receivedQty: 10, rejectedQty: 2, ratePaise: 5000 }]);
    expect(res.status).toBe(400);
  });

  it('refuses to reject more than arrived', async () => {
    const res = await receive(qcFactory.id, [
      { productId: cement.id, receivedQty: 5, rejectedQty: 9, rejectionReason: 'All damaged', ratePaise: 5000 },
    ]);
    expect(res.status).toBe(400);
  });

  it('records a wholly rejected delivery without creating an empty lot', async () => {
    const before = Number((await availability(qcFactory.id, cement.id)).onHand);

    const res = await receive(qcFactory.id, [
      { productId: cement.id, receivedQty: 6, rejectedQty: 6, rejectionReason: 'Wrong grade entirely', ratePaise: 5000 },
    ]);
    expect(res.status).toBe(201);
    expect(Number(res.body.data.lines[0].acceptedQty)).toBe(0);
    expect(res.body.data.lines[0].lotId).toBeNull();

    expect(Number((await availability(qcFactory.id, cement.id)).onHand)).toBe(before);
  });
});

describe('Final inspection — a held lot is not sellable until it passes', () => {
  let lotId;
  let entryId;

  it('parks a produced lot in QC_HOLD rather than making it available', async () => {
    const res = await produce(qcFactory.id, slab.id, 20);
    expect(res.status).toBe(201);
    lotId = res.body.data.lotId;
    entryId = res.body.data.id;

    const lot = await StockLot.findByPk(lotId);
    expect(lot.status).toBe('QC_HOLD');

    // On hand but not promisable, and the screen can say why.
    const bal = await availability(qcFactory.id, slab.id);
    expect(Number(bal.onHand)).toBe(20);
    expect(Number(bal.awaitingQc)).toBe(20);
    expect(Number(bal.available)).toBe(0);
  });

  it('lists the lot as awaiting clearance', async () => {
    const res = await request(app)
      .get(`/api/v1/quality/held-lots?factoryId=${qcFactory.id}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.some((l) => l.id === lotId)).toBe(true);
  });

  it('leaves the lot held while the test is still pending', async () => {
    const res = await request(app).post('/api/v1/quality').set('Cookie', adminCookie).send({
      factoryId: qcFactory.id, productId: slab.id, lotId, productionEntryId: entryId,
      inspectionType: 'FINAL', inspectionDate: '2026-08-27',
      testAgeDays: 7, sampleRef: 'CUBE-A', requiredValue: 25, unitLabel: 'N/mm2',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.result).toBe('PENDING');

    expect((await StockLot.findByPk(lotId)).status).toBe('QC_HOLD');
    expect(Number((await availability(qcFactory.id, slab.id)).available)).toBe(0);
  });

  it('releases the lot when a final test passes', async () => {
    const pending = await request(app)
      .get(`/api/v1/quality?factoryId=${qcFactory.id}&result=PENDING`)
      .set('Cookie', adminCookie);
    const inspectionId = pending.body.data.rows[0].id;

    const res = await request(app)
      .put(`/api/v1/quality/${inspectionId}/result`)
      .set('Cookie', adminCookie)
      .send({ result: 'PASS', testedValue: 31.5, remarks: '28-day cube' });
    expect(res.status).toBe(200);
    expect(res.body.data.result).toBe('PASS');

    expect((await StockLot.findByPk(lotId)).status).toBe('AVAILABLE');

    const bal = await availability(qcFactory.id, slab.id);
    expect(Number(bal.awaitingQc)).toBe(0);
    expect(Number(bal.available)).toBe(20);
  });

  it('refuses to overwrite a verdict already recorded', async () => {
    const all = await request(app)
      .get(`/api/v1/quality?factoryId=${qcFactory.id}&result=PASS`)
      .set('Cookie', adminCookie);
    const res = await request(app)
      .put(`/api/v1/quality/${all.body.data.rows[0].id}/result`)
      .set('Cookie', adminCookie)
      .send({ result: 'FAIL' });
    expect(res.status).toBe(400);
  });
});

describe('Final inspection — a failed lot is quarantined, not destroyed', () => {
  it('takes the lot out of sellable stock while leaving the quantity intact', async () => {
    const produced = await produce(qcFactory.id, slab.id, 8);
    const lotId = produced.body.data.lotId;

    const res = await request(app).post('/api/v1/quality').set('Cookie', adminCookie).send({
      factoryId: qcFactory.id, productId: slab.id, lotId,
      inspectionType: 'FINAL', inspectionDate: '2026-08-27',
      testAgeDays: 28, requiredValue: 25, testedValue: 18.2, unitLabel: 'N/mm2',
      result: 'FAIL', remarks: 'Below spec',
    });
    expect(res.status).toBe(201);

    const lot = await StockLot.findByPk(lotId);
    expect(lot.status).toBe('QC_FAILED');
    // The stock still exists — writing it off is a separate, deliberate act.
    expect(Number(lot.qtyAvailable)).toBe(8);

    const bal = await availability(qcFactory.id, slab.id);
    expect(Number(bal.qcFailed)).toBe(8);
  });

  it('will not let a failed lot be promised to a customer', async () => {
    const bal = await availability(qcFactory.id, slab.id);
    // Only the 20 released earlier are promisable; the failed 8 are not.
    expect(Number(bal.available)).toBe(20);
  });
});

describe('Opted out — nothing changes for a plant that does not work this way', () => {
  it('makes a produced lot available immediately when the factory has no QC hold', async () => {
    await receive(plainFactory.id, [{ productId: cement.id, receivedQty: 50, ratePaise: 5000 }]);

    // Same qcRequired product, but this factory has qcHoldEnabled false.
    const res = await produce(plainFactory.id, slab.id, 5);
    expect(res.status).toBe(201);

    expect((await StockLot.findByPk(res.body.data.lotId)).status).toBe('AVAILABLE');
    expect(Number((await availability(plainFactory.id, slab.id)).available)).toBe(5);
  });

  it('makes a non-qcRequired product available even inside a QC factory', async () => {
    const res = await produce(qcFactory.id, plainSlab.id, 6);
    expect(res.status).toBe(201);

    expect((await StockLot.findByPk(res.body.data.lotId)).status).toBe('AVAILABLE');
    expect(Number((await availability(qcFactory.id, plainSlab.id)).available)).toBe(6);
  });
});
