const request = require('supertest');
const bcrypt = require('bcryptjs');
const cls = require('cls-hooked');
const { NAMESPACE_NAME } = require('../src/core/tenantContext');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, ProductCategory,
  MixDesign, MixDesignLine, Party, StockLot,
} = require('../src/models/index');
const { AgeingService } = require('../src/api/inventory/ageing.service');
const { ReservationService } = require('../src/api/inventory/reservation.service');
const { StockLedgerService } = require('../src/api/inventory/stockLedger.service');

const PASSWORD = 'password123';
let adminCookie;
let tenantId;
let factory;
let rawMaterial;
let finishedGood;
let vendor;
let customer;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

// Services read tenantId from CLS (set by the request middleware chain), so
// tests calling them directly must open that context themselves.
const runInTenantContext = (fn) => {
  const session = cls.getNamespace(NAMESPACE_NAME) || cls.createNamespace(NAMESPACE_NAME);
  return session.runAndReturn(() => {
    session.set('tenantId', tenantId);
    return fn();
  });
};

// Every stock movement must be written inside a transaction (AP-1), so the
// seed helper opens one alongside the tenant context.
const seedLot = ({ productId, lotNumber, originDate, curingDaysOverride, quantity }) =>
  runInTenantContext(() =>
    sequelize.transaction(async (transaction) => {
      const lot = await StockLedgerService.createLot({
        factoryId: factory.id, productId, lotNumber, originType: 'PRODUCTION',
        originId: factory.id, originDate, curingDaysOverride, quantity, transaction,
      });
      await StockLedgerService.postEntry({
        factoryId: factory.id, productId, lotId: lot.id, movementType: 'PRODUCTION_IN',
        direction: 'IN', quantity, referenceType: 'Seed', referenceId: factory.id, transaction,
      });
      return lot;
    })
  );

const atp = async () =>
  (await request(app).get(`/api/v1/sales/atp?factoryId=${factory.id}&productId=${finishedGood.id}`).set('Cookie', adminCookie)).body.data;

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-resv', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@resv-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Reservation Factory', code: 'RSV-FAC' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-RSV' });
  rawMaterial = await Product.create({ tenantId, uomId: uom.id, name: 'Cement RSV', code: 'RM-CEM-RSV', productType: 'RAW_MATERIAL', curingDays: 0 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, name: 'Paver Block RSV', code: 'FG-PAV-RSV', productType: 'FINISHED_GOOD', curingDays: 14 });

  const mix = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });

  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'RSV Vendor' });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'RSV Customer' });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@resv-test.co', password: PASSWORD }), 'accessToken');

  await request(app)
    .post('/api/v1/purchasing/receipts')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-01-01', lines: [{ productId: rawMaterial.id, receivedQty: 1000, ratePaise: 5000 }] });
});

afterAll(async () => {
  await sequelize.close();
});

describe('AC-3.1 Availability excludes curing stock', () => {
  it('reports available and curing separately, and books the shortfall as production required', async () => {
    // 30 available (produced long ago, curing already elapsed) + 25 still curing.
    await seedLot({ productId: finishedGood.id, lotNumber: 'AVAIL-30', originDate: '2026-01-05', curingDaysOverride: 14, quantity: 30 });
    await seedLot({ productId: finishedGood.id, lotNumber: 'CURING-25', originDate: new Date().toISOString().slice(0, 10), curingDaysOverride: 14, quantity: 25 });

    const before = await atp();
    expect(before.onHand).toBe(55);
    expect(before.curing).toBe(25);
    expect(before.available).toBe(30); // NOT 55 — curing stock is not available stock

    const so = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-01', lines: [{ productId: finishedGood.id, orderedQty: 100, ratePaise: 1000 }] });
    expect(so.status).toBe(201);

    // Shortfall is 100 - 30 = 70, and emphatically not 100 - 55 = 45.
    expect(Number(so.body.data.lines[0].productionRequired)).toBe(70);
  });
});

describe('AC-3.4 Reservation lifecycle', () => {
  let orderId;
  let lineId;

  it('confirming an order reserves stock without writing any ledger entry', async () => {
    const ledgerBefore = await request(app).get(`/api/v1/inventory/ledger?factoryId=${factory.id}&productId=${finishedGood.id}&limit=100`).set('Cookie', adminCookie);
    const entriesBefore = ledgerBefore.body.data.count;

    const so = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-02', lines: [{ productId: finishedGood.id, orderedQty: 12, ratePaise: 1000 }] });
    orderId = so.body.data.id;
    lineId = so.body.data.lines[0].id;

    const availableBefore = (await atp()).available;
    await request(app).put(`/api/v1/sales/orders/${orderId}/confirm`).set('Cookie', adminCookie);

    const after = await atp();
    expect(after.onHand).toBe(55); // on-hand is untouched — nothing physically moved
    expect(after.reserved).toBe(12);
    expect(after.available).toBe(availableBefore - 12);

    const ledgerAfter = await request(app).get(`/api/v1/inventory/ledger?factoryId=${factory.id}&productId=${finishedGood.id}&limit=100`).set('Cookie', adminCookie);
    expect(ledgerAfter.body.data.count).toBe(entriesBefore); // AC-3.4: no ledger entry from a reservation
  });

  it('holds against specific lots in FIFO order', async () => {
    const holds = await runInTenantContext(() => ReservationService.listByReference('SalesOrderLine', lineId));
    expect(holds.length).toBeGreaterThan(0);
    expect(holds[0].lot.lotNumber).toBe('AVAIL-30'); // oldest available lot, not the curing one
    expect(holds.every((h) => h.lot.status === 'AVAILABLE')).toBe(true);
  });

  it('cancelling releases the hold and returns stock to available, still with no ledger entry', async () => {
    const beforeCancel = await atp();

    const cancelled = await request(app)
      .put(`/api/v1/sales/orders/${orderId}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Customer withdrew' });
    expect(cancelled.status).toBe(200);

    const after = await atp();
    expect(after.onHand).toBe(beforeCancel.onHand); // unchanged
    expect(after.reserved).toBe(0);
    expect(after.available).toBe(beforeCancel.available + 12);
  });
});

describe('AC-5.2 Ledger is the source of truth', () => {
  it('reports no drift on a healthy dataset', async () => {
    const { discrepancies } = await runInTenantContext(() => StockLedgerService.reconcileLedgerVsBalances({ factoryId: factory.id }));
    expect(discrepancies).toEqual([]);
  });

  it('detects deliberate corruption and repairs it from the ledger', async () => {
    const lot = await StockLot.findOne({ where: { lotNumber: 'AVAIL-30' } });
    const trueQty = Number(lot.qtyAvailable);
    await lot.update({ qtyAvailable: trueQty + 999 }, { hooks: false });

    const drifted = await runInTenantContext(() => StockLedgerService.reconcileLedgerVsBalances({ factoryId: factory.id }));
    expect(drifted.discrepancies).toHaveLength(1);
    expect(drifted.discrepancies[0].drift).toBe(999);

    await runInTenantContext(() => StockLedgerService.rebuildStockBalances({ factoryId: factory.id }));

    const repaired = await runInTenantContext(() => StockLedgerService.reconcileLedgerVsBalances({ factoryId: factory.id }));
    expect(repaired.discrepancies).toEqual([]);
    await lot.reload();
    expect(Number(lot.qtyAvailable)).toBe(trueQty);
  });
});

describe('AC-2.2 Ageing threshold cascade', () => {
  it('takes the most specific non-null value per field, not per level', () => {
    const category = { slowMovingDays: 100, deadStockDays: 150, alertBeforeDays: null };
    const factoryCfg = { slowMovingDays: null, deadStockDays: null, alertBeforeDays: null };

    // Product overrides nothing -> inherits the category's 100/150.
    const inherited = AgeingService.resolveThresholds({ product: {}, category, factory: factoryCfg });
    expect(inherited.slowMovingDays).toBe(100);
    expect(inherited.deadStockDays).toBe(150);
    expect(inherited.alertBeforeDays).toBe(30); // global default

    // Product overrides ONLY deadStockDays -> still inherits slowMoving from category.
    const partial = AgeingService.resolveThresholds({ product: { deadStockDays: 200 }, category, factory: factoryCfg });
    expect(partial.slowMovingDays).toBe(100);
    expect(partial.deadStockDays).toBe(200);
  });
});

describe('AC-13.1 / AC-13.2 Ageing classification', () => {
  it.each([
    [45, 'FRESH'],
    [119, 'FRESH'],
    [120, 'SLOW_MOVING'],
    [179, 'SLOW_MOVING'],
    [180, 'DEAD'],
    [210, 'DEAD'],
  ])('classifies a %i-day-old lot as %s', (age, expected) => {
    expect(AgeingService.classify(age, { slowMovingDays: 120, deadStockDays: 180 })).toBe(expected);
  });

  it('excludes CURING lots from classification entirely', async () => {
    await runInTenantContext(() => AgeingService.reclassifyAll());
    const curingLot = await StockLot.findOne({ where: { lotNumber: 'CURING-25' } });
    expect(curingLot.status).toBe('CURING');
    expect(curingLot.ageingClass).toBeNull(); // AC-13.2: curing stock is not aged
  });

  it('classifies an available lot and records when it was computed', async () => {
    await runInTenantContext(() => AgeingService.reclassifyAll());
    const lot = await StockLot.findOne({ where: { lotNumber: 'AVAIL-30' } });
    expect(['FRESH', 'SLOW_MOVING', 'DEAD']).toContain(lot.ageingClass);
    expect(lot.ageDays).toBeGreaterThan(0);
    expect(lot.ageingComputedAt).toBeTruthy();
  });
});

describe('AC-13.3 Near-dead alerting is idempotent', () => {
  it('alerts once when the lot enters the window and never again', async () => {
    const product = await Product.create({
      tenantId: factory.tenantId, uomId: (await Uom.findOne()).id, name: 'Ageing Probe', code: 'FG-AGE-PROBE',
      productType: 'FINISHED_GOOD', curingDays: 0, slowMovingDays: 120, deadStockDays: 180, alertBeforeDays: 30,
    });

    // 149 days old: outside the 30-day alert window (180 - 149 = 31).
    const originDate = new Date();
    originDate.setDate(originDate.getDate() - 149);
    const lot = await seedLot({
      productId: product.id, lotNumber: 'AGE-149',
      originDate: originDate.toISOString().slice(0, 10), quantity: 5,
    });

    const day149 = await runInTenantContext(() => AgeingService.reclassifyAll());
    expect(day149.newlyNearDead.some((n) => n.lot.id === lot.id)).toBe(false);

    // One day later (150 days old) it crosses into the window and alerts once.
    const day150 = new Date();
    day150.setDate(day150.getDate() + 1);
    const first = await runInTenantContext(() => AgeingService.reclassifyAll({ asOf: day150 }));
    expect(first.newlyNearDead.some((n) => n.lot.id === lot.id)).toBe(true);

    // Running again the next day must not re-alert for the same lot.
    const day151 = new Date();
    day151.setDate(day151.getDate() + 2);
    const second = await runInTenantContext(() => AgeingService.reclassifyAll({ asOf: day151 }));
    expect(second.newlyNearDead.some((n) => n.lot.id === lot.id)).toBe(false);
  });
});
