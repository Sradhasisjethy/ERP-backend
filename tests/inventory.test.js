const request = require('supertest');
const bcrypt = require('bcryptjs');
const cls = require('cls-hooked');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party,
} = require('../src/models/index');
const { StockLedgerService } = require('../src/api/inventory/stockLedger.service');
const { StockLot } = require('../src/api/inventory/stockLot.model');
const { StockLedgerEntry } = require('../src/api/inventory/stockLedgerEntry.model');
const { NAMESPACE_NAME } = require('../src/core/tenantContext');

const PASSWORD = 'password123';
let adminCookie;
let tenantId;
let factoryA; // allowNegativeStock: false
let factoryB; // allowNegativeStock: true
let rawMaterial;
let finishedGood;
let vendor;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

// Ledger service calls read tenantId from CLS (like the request middleware
// chain does) rather than taking it as a parameter, so tests that call the
// service directly (bypassing HTTP) need to open that context manually.
const runInTenantContext = (fn) => {
  const session = cls.getNamespace(NAMESPACE_NAME) || cls.createNamespace(NAMESPACE_NAME);
  return session.runAndReturn(() => {
    session.set('tenantId', tenantId);
    return fn();
  });
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-precast-inv', status: 'active' });
  tenantId = tenant.id;

  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@inv-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });

  factoryA = await Factory.create({ tenantId, organizationId: org.id, name: 'Factory A', code: 'FAC-A', allowNegativeStock: false });
  factoryB = await Factory.create({ tenantId, organizationId: org.id, name: 'Factory B', code: 'FAC-B', allowNegativeStock: true });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  rawMaterial = await Product.create({ tenantId, uomId: uom.id, name: 'Cement', code: 'RM-CEMENT-INV', productType: 'RAW_MATERIAL', curingDays: 0 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, name: 'Precast Slab', code: 'FG-SLAB-INV', productType: 'FINISHED_GOOD', curingDays: 3 });
  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Test Cement Supplier' });

  const login = await request(app).post('/api/v1/auth/login').send({ email: 'admin@inv-test.co', password: PASSWORD });
  adminCookie = extractCookie(login, 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('Goods Receipt posts stock (M12, BR-01, BR-02)', () => {
  let grnId;
  let lotId;

  it('creates a GRN and posts a PURCHASE_IN ledger entry + AVAILABLE lot for a raw material (curingDays=0)', async () => {
    const res = await request(app)
      .post('/api/v1/purchasing/receipts')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factoryA.id,
        vendorPartyId: vendor.id,
        receiptDate: '2026-08-10',
        lines: [{ productId: rawMaterial.id, receivedQty: 100, ratePaise: 50000 }],
      });

    expect(res.status).toBe(201);
    const line = res.body.data.lines[0];
    expect(line.receivedQty).toBe('100.0000');
    lotId = line.lotId;
    grnId = res.body.data.id;

    const lot = await StockLot.findByPk(lotId);
    expect(lot.status).toBe('AVAILABLE');
    expect(Number(lot.qtyAvailable)).toBe(100);
    expect(lot.originType).toBe('PURCHASE');

    const entries = await StockLedgerEntry.findAll({ where: { referenceType: 'GoodsReceipt', referenceId: grnId } });
    expect(entries).toHaveLength(1);
    expect(entries[0].movementType).toBe('PURCHASE_IN');
    expect(entries[0].direction).toBe('IN');
  });

  it('reflects the receipt in the stock balance endpoint', async () => {
    const res = await request(app)
      .get(`/api/v1/inventory/balance?factoryId=${factoryA.id}&productId=${rawMaterial.id}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.balance).toBe(100);
  });

  it('creates a CURING lot for a finished good with curingDays > 0, not immediately available', async () => {
    const res = await request(app)
      .post('/api/v1/purchasing/receipts')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factoryA.id,
        vendorPartyId: vendor.id,
        receiptDate: '2026-08-10',
        lines: [{ productId: finishedGood.id, receivedQty: 10, ratePaise: 100000 }],
      });

    expect(res.status).toBe(201);
    const lot = await StockLot.findByPk(res.body.data.lines[0].lotId);
    expect(lot.status).toBe('CURING');

    const balance = await request(app)
      .get(`/api/v1/inventory/balance?factoryId=${factoryA.id}&productId=${finishedGood.id}`)
      .set('Cookie', adminCookie);
    // CURING stock is visible in reports but not "available" (BR-07's spirit for M13's balance).
    expect(balance.body.data.balance).toBe(0);

    // BR-08 / AC-4.4: early release is refused without a reason...
    const noReason = await request(app).put(`/api/v1/inventory/lots/${lot.id}/release-early`).set('Cookie', adminCookie).send({});
    expect(noReason.status).toBe(400);

    // ...and when given one, the who/when/why are stamped permanently on the lot.
    const release = await request(app)
      .put(`/api/v1/inventory/lots/${lot.id}/release-early`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Urgent site requirement' });
    expect(release.status).toBe(200);
    expect(release.body.data.status).toBe('AVAILABLE');
    expect(release.body.data.releasedEarlyReason).toBe('Urgent site requirement');
    expect(release.body.data.releasedEarlyAt).toBeTruthy();
    expect(release.body.data.releasedEarlyBy).toBeTruthy();
  });
});

describe('Purchase Order -> GRN linking (M12)', () => {
  it('marks a PO RECEIVED once its full ordered quantity has arrived', async () => {
    const po = await request(app)
      .post('/api/v1/purchasing/orders')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factoryA.id,
        vendorPartyId: vendor.id,
        orderDate: '2026-08-10',
        lines: [{ productId: rawMaterial.id, orderedQty: 50, ratePaise: 50000 }],
      });
    expect(po.status).toBe(201);
    const poLineId = po.body.data.lines[0].id;

    const grn = await request(app)
      .post('/api/v1/purchasing/receipts')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factoryA.id,
        vendorPartyId: vendor.id,
        purchaseOrderId: po.body.data.id,
        receiptDate: '2026-08-11',
        lines: [{ productId: rawMaterial.id, receivedQty: 50, ratePaise: 50000, purchaseOrderLineId: poLineId }],
      });
    expect(grn.status).toBe(201);

    const updatedPo = await request(app).get(`/api/v1/purchasing/orders/${po.body.data.id}`).set('Cookie', adminCookie);
    expect(updatedPo.body.data.status).toBe('RECEIVED');
  });
});

describe('StockLedgerService core (BR-01, BR-03, BR-04, BR-05)', () => {
  it('FIFO-consumes across two lots, oldest first', async () => {
    await runInTenantContext(async () => {
      // Unmanaged transaction (not sequelize.transaction(async (t) => ...)):
      // we want to roll back deliberately at the end without Sequelize then
      // trying to auto-commit the same transaction afterwards.
      const t = await sequelize.transaction();
      try {
        const lot1 = await StockLedgerService.createLot({
          factoryId: factoryA.id, productId: rawMaterial.id, lotNumber: 'FIFO-OLD',
          originType: 'PURCHASE', originId: '00000000-0000-0000-0000-000000000001',
          originDate: '2026-01-01', quantity: 30, transaction: t,
        });
        await StockLedgerService.postEntry({
          factoryId: factoryA.id, productId: rawMaterial.id, lotId: lot1.id,
          movementType: 'PURCHASE_IN', direction: 'IN', quantity: 30,
          referenceType: 'Test', referenceId: lot1.id, transaction: t,
        });
        const lot2 = await StockLedgerService.createLot({
          factoryId: factoryA.id, productId: rawMaterial.id, lotNumber: 'FIFO-NEW',
          originType: 'PURCHASE', originId: '00000000-0000-0000-0000-000000000002',
          originDate: '2026-02-01', quantity: 30, transaction: t,
        });
        await StockLedgerService.postEntry({
          factoryId: factoryA.id, productId: rawMaterial.id, lotId: lot2.id,
          movementType: 'PURCHASE_IN', direction: 'IN', quantity: 30,
          referenceType: 'Test', referenceId: lot2.id, transaction: t,
        });

        const consumed = await StockLedgerService.consumeFifo({
          factoryId: factoryA.id, productId: rawMaterial.id, quantity: 40,
          movementType: 'SALE_OUT', referenceType: 'Test', referenceId: '00000000-0000-0000-0000-0000000000ff', transaction: t,
        });

        expect(consumed).toEqual([
          { lotId: lot1.id, quantity: 30 },
          { lotId: lot2.id, quantity: 10 },
        ]);

        const reloadedLot1 = await StockLot.findByPk(lot1.id, { transaction: t });
        const reloadedLot2 = await StockLot.findByPk(lot2.id, { transaction: t });
        expect(Number(reloadedLot1.qtyAvailable)).toBe(0);
        expect(Number(reloadedLot2.qtyAvailable)).toBe(20);

        await t.rollback();
      } catch (err) {
        await t.rollback();
        throw err;
      }
    });
  });

  it('blocks a movement that would take a lot negative when the factory does not allow it (BR-04)', async () => {
    await runInTenantContext(() =>
      sequelize.transaction(async (t) => {
        const lot = await StockLedgerService.createLot({
          factoryId: factoryA.id, productId: rawMaterial.id, lotNumber: 'NEG-TEST-A',
          originType: 'PURCHASE', originId: '00000000-0000-0000-0000-000000000003',
          originDate: '2026-01-01', quantity: 5, transaction: t,
        });
        await expect(
          StockLedgerService.postEntry({
            factoryId: factoryA.id, productId: rawMaterial.id, lotId: lot.id,
            movementType: 'SALE_OUT', direction: 'OUT', quantity: 10,
            referenceType: 'Test', referenceId: lot.id, transaction: t,
          })
        ).rejects.toThrow(/Insufficient stock/);
      })
    );
  });

  it('allows negative stock and flags it when the factory explicitly permits it (BR-04)', async () => {
    await runInTenantContext(() =>
      sequelize.transaction(async (t) => {
        const lot = await StockLedgerService.createLot({
          factoryId: factoryB.id, productId: rawMaterial.id, lotNumber: 'NEG-TEST-B',
          originType: 'PURCHASE', originId: '00000000-0000-0000-0000-000000000004',
          originDate: '2026-01-01', quantity: 5, transaction: t,
        });
        await StockLedgerService.postEntry({
          factoryId: factoryB.id, productId: rawMaterial.id, lotId: lot.id,
          movementType: 'PURCHASE_IN', direction: 'IN', quantity: 5,
          referenceType: 'Test', referenceId: lot.id, transaction: t,
        });
        const entry = await StockLedgerService.postEntry({
          factoryId: factoryB.id, productId: rawMaterial.id, lotId: lot.id,
          movementType: 'SALE_OUT', direction: 'OUT', quantity: 10,
          referenceType: 'Test', referenceId: lot.id, transaction: t,
        });
        expect(entry.isNegativeStockEvent).toBe(true);

        const reloaded = await StockLot.findByPk(lot.id, { transaction: t });
        expect(Number(reloaded.qtyAvailable)).toBe(-5);
      })
    );
  });

  it('reverses an entry without touching the original (BR-05)', async () => {
    await runInTenantContext(() =>
      sequelize.transaction(async (t) => {
        const lot = await StockLedgerService.createLot({
          factoryId: factoryA.id, productId: rawMaterial.id, lotNumber: 'REV-TEST',
          originType: 'PURCHASE', originId: '00000000-0000-0000-0000-000000000005',
          originDate: '2026-01-01', quantity: 20, transaction: t,
        });
        await StockLedgerService.postEntry({
          factoryId: factoryA.id, productId: rawMaterial.id, lotId: lot.id,
          movementType: 'PURCHASE_IN', direction: 'IN', quantity: 20,
          referenceType: 'Test', referenceId: lot.id, transaction: t,
        });
        const outEntry = await StockLedgerService.postEntry({
          factoryId: factoryA.id, productId: rawMaterial.id, lotId: lot.id,
          movementType: 'SALE_OUT', direction: 'OUT', quantity: 8,
          referenceType: 'Test', referenceId: lot.id, transaction: t,
        });

        await StockLedgerService.reverseEntry(outEntry.id, 'Test correction', t);

        const reloadedLot = await StockLot.findByPk(lot.id, { transaction: t });
        expect(Number(reloadedLot.qtyAvailable)).toBe(20); // fully restored

        const originalStillIntact = await StockLedgerEntry.findByPk(outEntry.id, { transaction: t });
        expect(originalStillIntact.quantity).toBe('8.0000');
        expect(originalStillIntact.direction).toBe('OUT'); // unmodified
      })
    );
  });
});

describe('Inter-factory Stock Transfer (M14)', () => {
  let sourceLotId;

  beforeAll(async () => {
    const grn = await request(app)
      .post('/api/v1/purchasing/receipts')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factoryA.id,
        vendorPartyId: vendor.id,
        receiptDate: '2026-08-10',
        lines: [{ productId: rawMaterial.id, receivedQty: 60, ratePaise: 50000 }],
      });
    sourceLotId = grn.body.data.lines[0].lotId;
  });

  it('initiating a transfer reduces source stock and sets status IN_TRANSIT', async () => {
    const res = await request(app)
      .post('/api/v1/transfers')
      .set('Cookie', adminCookie)
      .send({
        fromFactoryId: factoryA.id,
        toFactoryId: factoryB.id,
        initiatedDate: '2026-08-12',
        lines: [{ productId: rawMaterial.id, sourceLotId, quantity: 20 }],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('IN_TRANSIT');

    const sourceLot = await StockLot.findByPk(sourceLotId);
    expect(Number(sourceLot.qtyAvailable)).toBe(40); // 60 - 20
  });

  it('receiving the transfer creates a new lot at the destination factory', async () => {
    const list = await request(app).get(`/api/v1/transfers?fromFactoryId=${factoryA.id}`).set('Cookie', adminCookie);
    const transfer = list.body.data.rows[0];
    const lineId = transfer.lines[0].id;

    const res = await request(app)
      .put(`/api/v1/transfers/${transfer.id}/receive`)
      .set('Cookie', adminCookie)
      .send({ receivedDate: '2026-08-13', lines: [{ lineId, receivedQuantity: 20 }] });

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('RECEIVED');

    const destLotId = res.body.data.lines[0].destinationLotId;
    const destLot = await StockLot.findByPk(destLotId);
    expect(destLot.factoryId).toBe(factoryB.id);
    expect(Number(destLot.qtyAvailable)).toBe(20);

    const balance = await request(app)
      .get(`/api/v1/inventory/balance?factoryId=${factoryB.id}&productId=${rawMaterial.id}`)
      .set('Cookie', adminCookie);
    expect(balance.body.data.balance).toBe(20);
  });

  it('cancelling an in-transit transfer reverses the outbound entry', async () => {
    const grn = await request(app)
      .post('/api/v1/purchasing/receipts')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factoryA.id,
        vendorPartyId: vendor.id,
        receiptDate: '2026-08-10',
        lines: [{ productId: rawMaterial.id, receivedQty: 15, ratePaise: 50000 }],
      });
    const cancelSourceLotId = grn.body.data.lines[0].lotId;

    const transfer = await request(app)
      .post('/api/v1/transfers')
      .set('Cookie', adminCookie)
      .send({
        fromFactoryId: factoryA.id,
        toFactoryId: factoryB.id,
        initiatedDate: '2026-08-14',
        lines: [{ productId: rawMaterial.id, sourceLotId: cancelSourceLotId, quantity: 15 }],
      });

    const beforeCancel = await StockLot.findByPk(cancelSourceLotId);
    expect(Number(beforeCancel.qtyAvailable)).toBe(0);

    const cancelled = await request(app)
      .put(`/api/v1/transfers/${transfer.body.data.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Wrong factory selected' });

    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const afterCancel = await StockLot.findByPk(cancelSourceLotId);
    expect(Number(afterCancel.qtyAvailable)).toBe(15); // restored
  });
});
