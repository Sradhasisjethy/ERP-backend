const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party,
  AdGroup, AdGroupMember, UserFactory, StockLot, StockLedgerEntry, StockReservation,
  MixDesign, MixDesignLine, AuditLog,
} = require('../src/models/index');
const { StockLedgerService } = require('../src/api/inventory/stockLedger.service');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

let T;
let admin;
let plantBOnly;
let readOnly;
let other;

const as = (cookie) => ({
  get: (p) => request(app).get(p).set('Cookie', cookie),
  post: (p, b) => request(app).post(p).set('Cookie', cookie).send(b),
  put: (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {}),
});

const product = async (name, code, type = 'RAW_MATERIAL', extra = {}) =>
  Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name, code, productType: type, ...extra });

/** Receives `qty` into `factory` and returns the GRN body. */
const receive = async (factory, p, qty, date = '2026-08-01') => {
  const res = await as(admin).post('/api/v1/purchasing/receipts', {
    factoryId: factory.id, vendorPartyId: T.vendor.id, receiptDate: date,
    lines: [{ productId: p.id, receivedQty: qty, ratePaise: 1000 }],
  });
  if (res.status !== 201) throw new Error(`receive failed: ${res.status} ${res.body.message}`);
  return res.body.data;
};

/** Ledger net for a product at a factory: Σ IN − Σ OUT, straight from the movements. */
const ledgerNet = async (factoryId, productId) => {
  const entries = await StockLedgerEntry.findAll({ where: { factoryId, productId } });
  return entries.reduce((s, e) => s + (e.direction === 'IN' ? Number(e.quantity) : -Number(e.quantity)), 0);
};

/** Sum of the derived per-lot projection, all statuses. */
const lotSum = async (factoryId, productId) => {
  const lots = await StockLot.findAll({ where: { factoryId, productId } });
  return lots.reduce((s, l) => s + Number(l.qtyAvailable), 0);
};

const balance = async (factoryId, productId, cookie = admin) =>
  Number((await as(cookie).get(`/api/v1/inventory/balance?factoryId=${factoryId}&productId=${productId}`)).body.data.balance);

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Inventory Audit Co', slug: 'inv-audit', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Inv Audit Pvt Ltd', code: 'IAC' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@inv-audit.test', passwordHash, firstName: 'A', lastName: 'A', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });

  const plantA = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant A', code: 'PA', state: 'Odisha', dispatchTolerancePercent: 0 });
  const plantB = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant B', code: 'PB', state: 'Odisha' });
  // BR-04: one factory is explicitly configured to permit negative stock.
  const loose = await Factory.create({ tenantId, organizationId: org.id, name: 'Loose Plant', code: 'LP', state: 'Odisha', allowNegativeStock: true });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Supplier Co', state: 'Odisha' });
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Buyer Co', state: 'Odisha' });

  T = { tenantId, org, plantA, plantB, loose, uom, vendor, customer };
  admin = await loginAs('admin@inv-audit.test');

  const mkUser = async (email, permissions, factoryId) => {
    const u = await User.create({ tenantId, email, passwordHash, firstName: 'X', lastName: 'Y', role: 'EMPLOYEE' }, { validate: false });
    const g = await AdGroup.create({ tenantId, name: `G ${email}`, permissions });
    await AdGroupMember.create({ tenantId, adGroupId: g.id, employeeId: u.id });
    if (factoryId) await UserFactory.create({ tenantId, userId: u.id, factoryId });
    return loginAs(email);
  };
  plantBOnly = await mkUser('plantb@inv-audit.test', ['INVENTORY_READ', 'INVENTORY_CREATE', 'INVENTORY_MODIFY', 'REPORT_INVENTORY_READ'], plantB.id);
  readOnly = await mkUser('viewer@inv-audit.test', ['INVENTORY_READ'], plantA.id);

  const t2 = await Tenant.create({ name: 'Rival', slug: 'inv-rival', status: 'active' });
  const org2 = await Organization.create({ tenantId: t2.id, name: 'Rival Pvt', code: 'RIV' });
  await User.create({ tenantId: t2.id, email: 'admin@inv-rival.test', passwordHash, firstName: 'R', lastName: 'R', role: 'PLATFORM_ADMIN' }, { validate: false });
  await FinancialYear.create({ tenantId: t2.id, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const rf = await Factory.create({ tenantId: t2.id, organizationId: org2.id, name: 'Rival Plant', code: 'RP', state: 'Odisha' });
  const ru = await Uom.create({ tenantId: t2.id, name: 'Numbers', code: 'NOS' });
  const rp = await Product.create({ tenantId: t2.id, uomId: ru.id, name: 'Rival Item', code: 'RM-X', productType: 'RAW_MATERIAL' });
  other = { tenantId: t2.id, factory: rf, product: rp, cookie: await loginAs('admin@inv-rival.test') };
});

afterAll(async () => {
  await sequelize.close();
});

// ===========================================================================
// A. Stock mutation matrix — every source, exactly one movement, right way
// ===========================================================================
describe('A. Stock mutation matrix', () => {
  it('Purchase: one IN, no reservation', async () => {
    const p = await product('Mtx Purchase', 'MTX-PUR');
    await receive(T.plantA, p, 100);

    const entries = await StockLedgerEntry.findAll({ where: { productId: p.id } });
    expect(entries).toHaveLength(1);
    expect(entries[0].direction).toBe('IN');
    expect(entries[0].movementType).toBe('PURCHASE_IN');
    expect(await StockReservation.count({ where: { productId: p.id } })).toBe(0);
    expect(await lotSum(T.plantA.id, p.id)).toBe(100);
  });

  it('Purchase return: one OUT against the received lot', async () => {
    const p = await product('Mtx PRet', 'MTX-PRET');
    const grn = await receive(T.plantA, p, 50);

    const ret = await as(admin).post('/api/v1/returns/purchase-returns', {
      factoryId: T.plantA.id, vendorPartyId: T.vendor.id, returnDate: '2026-08-02', reason: 'damaged on arrival',
      lines: [{ productId: p.id, lotId: grn.lines[0].lotId, quantity: 20, ratePaise: 1000 }],
    });
    expect(ret.status).toBe(201);

    const outs = await StockLedgerEntry.findAll({ where: { productId: p.id, direction: 'OUT' } });
    expect(outs).toHaveLength(1);
    expect(await ledgerNet(T.plantA.id, p.id)).toBe(30);
    expect(await lotSum(T.plantA.id, p.id)).toBe(30);
  });

  it('Sale: one OUT, and the reservation is CONSUMED not released', async () => {
    const p = await product('Mtx Sale', 'MTX-SALE', 'FINISHED_GOOD');
    await receive(T.plantA, p, 100);

    const order = await as(admin).post('/api/v1/sales/orders', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, orderDate: '2026-08-03',
      lines: [{ productId: p.id, orderedQty: 40, ratePaise: 1000 }],
    });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    // Reserving alone must NOT write a stock movement.
    expect(await StockLedgerEntry.count({ where: { productId: p.id, direction: 'OUT' } })).toBe(0);

    await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: order.body.data.id, vehicleNumber: 'OD-1', dispatchDate: '2026-08-04',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 40 }],
    });

    const outs = await StockLedgerEntry.findAll({ where: { productId: p.id, direction: 'OUT' } });
    expect(outs).toHaveLength(1);
    expect(outs[0].movementType).toBe('SALE_OUT');
    expect(await StockReservation.count({ where: { productId: p.id, status: 'CONSUMED' } })).toBeGreaterThan(0);
    expect(await ledgerNet(T.plantA.id, p.id)).toBe(60);
  });

  it('Production: finished goods IN and raw material OUT, per the BOM', async () => {
    const rm = await product('Mtx RM', 'MTX-RM');
    const fg = await product('Mtx FG', 'MTX-FG', 'FINISHED_GOOD');
    const bom = await MixDesign.create({ tenantId: T.tenantId, productId: fg.id, name: 'Mix', version: 1, isActive: true, status: 'ACTIVE', effectiveFrom: '2026-04-01' });
    await MixDesignLine.create({ tenantId: T.tenantId, mixDesignId: bom.id, rawMaterialProductId: rm.id, quantityPerUnit: 2, uomId: T.uom.id });
    await receive(T.plantA, rm, 200);

    const entry = await as(admin).post('/api/v1/production/entries', {
      factoryId: T.plantA.id, productId: fg.id, productionDate: '2026-08-05', goodQty: 50, rejectedQty: 0,
    });
    expect(entry.status).toBe(201);

    expect(await ledgerNet(T.plantA.id, fg.id)).toBe(50);   // FG in
    expect(await ledgerNet(T.plantA.id, rm.id)).toBe(100);  // 200 − (2 × 50)

    const fgEntries = await StockLedgerEntry.findAll({ where: { productId: fg.id } });
    expect(fgEntries.every((e) => e.direction === 'IN')).toBe(true);
    const rmOut = await StockLedgerEntry.findAll({ where: { productId: rm.id, direction: 'OUT' } });
    expect(rmOut.every((e) => e.movementType === 'PRODUCTION_OUT')).toBe(true);
  });

  it('Transfer: source OUT on send, destination IN on receive, and neither owns it in between', async () => {
    const p = await product('Mtx Trf', 'MTX-TRF');
    const grn = await receive(T.plantA, p, 80);

    const sent = await as(admin).post('/api/v1/transfers', {
      fromFactoryId: T.plantA.id, toFactoryId: T.plantB.id, initiatedDate: '2026-08-06',
      lines: [{ productId: p.id, sourceLotId: grn.lines[0].lotId, quantity: 30 }],
    });
    expect(sent.status).toBe(201);

    // Source is down; destination has nothing yet.
    expect(await ledgerNet(T.plantA.id, p.id)).toBe(50);
    expect(await ledgerNet(T.plantB.id, p.id)).toBe(0);
    // In-transit belongs to neither factory's available stock.
    const atp = await as(admin).get(`/api/v1/sales/atp?factoryId=${T.plantA.id}&productId=${p.id}`);
    expect(atp.body.data.inTransit).toBe(30);

    const received = await as(admin).put(`/api/v1/transfers/${sent.body.data.id}/receive`, {
      receivedDate: '2026-08-08',
      lines: [{ lineId: sent.body.data.lines[0].id, receivedQuantity: 30 }],
    });
    expect(received.status).toBe(200);

    expect(await ledgerNet(T.plantA.id, p.id)).toBe(50);
    expect(await ledgerNet(T.plantB.id, p.id)).toBe(30);
    // Total across the business is conserved.
    expect((await ledgerNet(T.plantA.id, p.id)) + (await ledgerNet(T.plantB.id, p.id))).toBe(80);
  });

  it('Cancellation: a reversal is a new opposite entry, never an edit or a delete', async () => {
    const p = await product('Mtx Rev', 'MTX-REV');
    const grn = await receive(T.plantA, p, 40);

    await as(admin).put(`/api/v1/purchasing/receipts/${grn.id}/cancel`, { reason: 'wrong material' });

    const entries = await StockLedgerEntry.findAll({ where: { productId: p.id }, order: [['createdAt', 'ASC']] });
    expect(entries).toHaveLength(2);
    expect(entries[0].movementType).toBe('PURCHASE_IN');
    expect(entries[1].movementType).toBe('REVERSAL');
    expect(entries[1].direction).toBe('OUT');
    expect(entries[1].reversalOfEntryId).toBe(entries[0].id);
    // The original is untouched — corrections never rewrite history.
    expect(Number(entries[0].quantity)).toBe(40);
    expect(await ledgerNet(T.plantA.id, p.id)).toBe(0);
  });

  it('Reservation and release write no stock movement at all', async () => {
    const p = await product('Mtx Resv', 'MTX-RESV', 'FINISHED_GOOD');
    await receive(T.plantA, p, 100);
    const before = await StockLedgerEntry.count({ where: { productId: p.id } });

    const order = await as(admin).post('/api/v1/sales/orders', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, orderDate: '2026-08-03',
      lines: [{ productId: p.id, orderedQty: 40, ratePaise: 1000 }],
    });
    await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/cancel`, { reason: 'customer withdrew' });

    expect(await StockLedgerEntry.count({ where: { productId: p.id } })).toBe(before);
    expect(await lotSum(T.plantA.id, p.id)).toBe(100);
  });
});

// ===========================================================================
// B. Balance is a projection of the ledger, and they agree
// ===========================================================================
describe('B. Balance reconciles to the movement ledger', () => {
  it('every lot balance equals the sum of its movements after a mixed workload', async () => {
    const { checked, discrepancies } = await StockLedgerService.reconcileLedgerVsBalances();
    expect(checked).toBeGreaterThan(0);
    expect(discrepancies).toEqual([]);
  });

  it('rebuilding balances from the ledger reproduces exactly the same numbers', async () => {
    const before = await StockLot.findAll({ attributes: ['id', 'qtyAvailable'], order: [['id', 'ASC']] });
    await StockLedgerService.rebuildStockBalances();
    const after = await StockLot.findAll({ attributes: ['id', 'qtyAvailable'], order: [['id', 'ASC']] });

    expect(after).toHaveLength(before.length);
    for (let i = 0; i < before.length; i += 1) {
      expect([before[i].id, Number(after[i].qtyAvailable)]).toEqual([before[i].id, Number(before[i].qtyAvailable)]);
    }
  });

  it('the balance endpoint agrees with the ledger for stock that is not curing', async () => {
    const p = await product('Bal Plain', 'BAL-PLAIN');
    await receive(T.plantA, p, 60);
    expect(await balance(T.plantA.id, p.id)).toBe(60);
    expect(await ledgerNet(T.plantA.id, p.id)).toBe(60);
  });

  it('reports physical stock separately from sellable stock when a lot is still curing', async () => {
    const p = await product('Bal Curing', 'BAL-CURING', 'FINISHED_GOOD', { curingDays: 30 });
    await receive(T.plantA, p, 70, '2026-08-18'); // still inside its curing window

    // The ledger — and therefore physical stock — says 70.
    expect(await ledgerNet(T.plantA.id, p.id)).toBe(70);
    expect(await lotSum(T.plantA.id, p.id)).toBe(70);

    // A caller asking "what is in this warehouse?" must be able to get 70,
    // and must be told 0 is sellable — not silently handed one for the other.
    const res = await as(admin).get(`/api/v1/inventory/balance?factoryId=${T.plantA.id}&productId=${p.id}`);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.onHand)).toBe(70);
    expect(Number(res.body.data.available)).toBe(0);
    expect(Number(res.body.data.curing)).toBe(70);
  });
});

// ===========================================================================
// C. Reservation arithmetic
// ===========================================================================
describe('C. Reservation', () => {
  const atp = async (factoryId, productId) =>
    (await as(admin).get(`/api/v1/sales/atp?factoryId=${factoryId}&productId=${productId}`)).body.data;

  it('available = physical − reserved, and a release restores it', async () => {
    const p = await product('Rsv A', 'RSV-A', 'FINISHED_GOOD');
    await receive(T.plantA, p, 100);
    expect((await atp(T.plantA.id, p.id)).available).toBe(100);

    const order = await as(admin).post('/api/v1/sales/orders', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, orderDate: '2026-08-03',
      lines: [{ productId: p.id, orderedQty: 35, ratePaise: 1000 }],
    });
    await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);

    const held = await atp(T.plantA.id, p.id);
    expect(held.onHand).toBe(100);
    expect(held.reserved).toBe(35);
    expect(held.available).toBe(65);

    await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/cancel`, { reason: 'released' });
    expect((await atp(T.plantA.id, p.id)).available).toBe(100);
  });

  it('reserves only what exists and reports the shortfall', async () => {
    const p = await product('Rsv B', 'RSV-B', 'FINISHED_GOOD');
    await receive(T.plantA, p, 30);
    const order = await as(admin).post('/api/v1/sales/orders', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, orderDate: '2026-08-03',
      lines: [{ productId: p.id, orderedQty: 100, ratePaise: 1000 }],
    });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    expect(Number(confirmed.body.data.lines[0].productionRequired)).toBe(70);
    expect((await atp(T.plantA.id, p.id)).reserved).toBe(30);
  });

  it('never reserves curing stock', async () => {
    const p = await product('Rsv C', 'RSV-C', 'FINISHED_GOOD', { curingDays: 30 });
    await receive(T.plantA, p, 50, '2026-08-18');
    const a = await atp(T.plantA.id, p.id);
    expect(a.curing).toBe(50);
    expect(a.available).toBe(0);
  });

  it('two concurrent reservations never hold more than exists', async () => {
    const p = await product('Rsv D', 'RSV-D', 'FINISHED_GOOD');
    await receive(T.plantA, p, 100);

    const mk = async () => {
      const o = await as(admin).post('/api/v1/sales/orders', {
        factoryId: T.plantA.id, customerPartyId: T.customer.id, orderDate: '2026-08-03',
        lines: [{ productId: p.id, orderedQty: 80, ratePaise: 1000 }],
      });
      return o.body.data.id;
    };
    const [id1, id2] = [await mk(), await mk()];
    const [r1, r2] = await Promise.all([
      as(admin).put(`/api/v1/sales/orders/${id1}/confirm`),
      as(admin).put(`/api/v1/sales/orders/${id2}/confirm`),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    const held = Number(await StockReservation.sum('quantity', { where: { productId: p.id, status: 'ACTIVE' } }));
    expect(held).toBeLessThanOrEqual(100);
    expect((await atp(T.plantA.id, p.id)).available).toBeGreaterThanOrEqual(0);
  });
});

// ===========================================================================
// D. Negative stock and concurrency
// ===========================================================================
describe('D. Negative stock', () => {
  it('refuses to issue more than exists when the factory forbids negative stock', async () => {
    const p = await product('Neg A', 'NEG-A', 'FINISHED_GOOD');
    await receive(T.plantA, p, 10);

    const order = await as(admin).post('/api/v1/sales/orders', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, orderDate: '2026-08-03',
      lines: [{ productId: p.id, orderedQty: 50, ratePaise: 1000 }],
    });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);

    const over = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: order.body.data.id, vehicleNumber: 'OD-2', dispatchDate: '2026-08-04',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 50 }],
    });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/insufficient stock/i);

    expect(await ledgerNet(T.plantA.id, p.id)).toBe(10);
    expect(await lotSum(T.plantA.id, p.id)).toBe(10);
  });

  it('the two-users-one-stock race never drives stock negative', async () => {
    // The brief's scenario: available 150, two users each take 100.
    const p = await product('Neg B', 'NEG-B', 'FINISHED_GOOD');
    await receive(T.plantA, p, 150);

    const build = async () => {
      const o = await as(admin).post('/api/v1/sales/orders', {
        factoryId: T.plantA.id, customerPartyId: T.customer.id, orderDate: '2026-08-03',
        lines: [{ productId: p.id, orderedQty: 100, ratePaise: 1000 }],
      });
      const c = await as(admin).put(`/api/v1/sales/orders/${o.body.data.id}/confirm`);
      return { orderId: o.body.data.id, lineId: c.body.data.lines[0].id };
    };
    const a = await build();
    const b = await build();

    const [r1, r2] = await Promise.all([
      as(admin).post('/api/v1/dispatch/challans', {
        salesOrderId: a.orderId, vehicleNumber: 'OD-3', dispatchDate: '2026-08-04',
        lines: [{ salesOrderLineId: a.lineId, dispatchedQty: 100 }],
      }),
      as(admin).post('/api/v1/dispatch/challans', {
        salesOrderId: b.orderId, vehicleNumber: 'OD-4', dispatchDate: '2026-08-04',
        lines: [{ salesOrderLineId: b.lineId, dispatchedQty: 100 }],
      }),
    ]);

    // One succeeds, one is refused — never both.
    expect([r1, r2].filter((r) => r.status === 201).length).toBe(1);

    const net = await ledgerNet(T.plantA.id, p.id);
    expect(net).toBe(50);
    expect(net).toBeGreaterThanOrEqual(0);
    expect(await lotSum(T.plantA.id, p.id)).toBe(50);
  });

  it('permits negative stock only where the factory explicitly allows it, and flags the event', async () => {
    const p = await product('Neg C', 'NEG-C');
    const grn = await receive(T.loose, p, 5);

    // Return more than is on hand at a factory configured with allowNegativeStock.
    const res = await as(admin).post('/api/v1/returns/purchase-returns', {
      factoryId: T.loose.id, vendorPartyId: T.vendor.id, returnDate: '2026-08-05', reason: 'over-return test',
      lines: [{ productId: p.id, lotId: grn.lines[0].lotId, quantity: 8, ratePaise: 1000 }],
    });
    expect(res.status).toBe(201);
    expect(await ledgerNet(T.loose.id, p.id)).toBe(-3);

    const flagged = await StockLedgerEntry.findAll({ where: { productId: p.id, isNegativeStockEvent: true } });
    expect(flagged.length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// E. Stock adjustment
// ===========================================================================
describe('E. Stock adjustment', () => {
  it('records a physical count correction with reason, before and after quantities, user and location', async () => {
    const p = await product('Adj A', 'ADJ-A');
    const grn = await receive(T.plantA, p, 100);

    // Warehouse counted 92 against a system figure of 100.
    const adj = await as(admin).post('/api/v1/inventory/adjustments', {
      factoryId: T.plantA.id,
      productId: p.id,
      lotId: grn.lines[0].lotId,
      countedQty: 92,
      reason: 'Quarterly physical count — 8 units broken in storage',
    });
    expect(adj.status).toBe(201);

    const body = adj.body.data;
    expect(Number(body.previousQty)).toBe(100);
    expect(Number(body.countedQty)).toBe(92);
    expect(Number(body.adjustmentQty)).toBe(-8);
    expect(Number(body.newQty)).toBe(92);
    expect(body.factoryId).toBe(T.plantA.id);
    expect(body.reason).toMatch(/physical count/i);
    expect(body.createdBy).toBeTruthy();

    // The stock moved, once, in the right direction.
    expect(await ledgerNet(T.plantA.id, p.id)).toBe(92);
    expect(await lotSum(T.plantA.id, p.id)).toBe(92);
    const outs = await StockLedgerEntry.findAll({ where: { productId: p.id, movementType: 'ADJUSTMENT_OUT' } });
    expect(outs).toHaveLength(1);
    expect(Number(outs[0].quantity)).toBe(8);
  });

  it('records an upward correction as an ADJUSTMENT_IN', async () => {
    const p = await product('Adj B', 'ADJ-B');
    const grn = await receive(T.plantA, p, 50);

    const adj = await as(admin).post('/api/v1/inventory/adjustments', {
      factoryId: T.plantA.id, productId: p.id, lotId: grn.lines[0].lotId,
      countedQty: 57, reason: 'Found 7 units mis-shelved',
    });
    expect(adj.status).toBe(201);
    expect(Number(adj.body.data.adjustmentQty)).toBe(7);
    expect(await ledgerNet(T.plantA.id, p.id)).toBe(57);
    expect(await StockLedgerEntry.count({ where: { productId: p.id, movementType: 'ADJUSTMENT_IN' } })).toBe(1);
  });

  it('requires a reason and refuses a no-op', async () => {
    const p = await product('Adj C', 'ADJ-C');
    const grn = await receive(T.plantA, p, 20);

    expect((await as(admin).post('/api/v1/inventory/adjustments', {
      factoryId: T.plantA.id, productId: p.id, lotId: grn.lines[0].lotId, countedQty: 15,
    })).status).toBe(400);

    const noop = await as(admin).post('/api/v1/inventory/adjustments', {
      factoryId: T.plantA.id, productId: p.id, lotId: grn.lines[0].lotId, countedQty: 20, reason: 'count matches',
    });
    expect(noop.status).toBe(400);
    expect(noop.body.message).toMatch(/already|no adjustment|matches/i);
  });

  it('refuses a negative count and a count that would drive stock below zero', async () => {
    const p = await product('Adj D', 'ADJ-D');
    const grn = await receive(T.plantA, p, 20);
    expect((await as(admin).post('/api/v1/inventory/adjustments', {
      factoryId: T.plantA.id, productId: p.id, lotId: grn.lines[0].lotId, countedQty: -1, reason: 'nonsense',
    })).status).toBe(400);
  });

  it('is listable, auditable, and appears on the stock adjustments report', async () => {
    const listed = await as(admin).get(`/api/v1/inventory/adjustments?factoryId=${T.plantA.id}&limit=50`);
    expect(listed.status).toBe(200);
    expect(listed.body.data.rows.length).toBeGreaterThan(0);

    const trail = await AuditLog.findAll({ where: { entityType: 'StockAdjustment' } });
    expect(trail.length).toBeGreaterThan(0);
    expect(trail.every((r) => r.userId)).toBe(true);

    const report = await as(admin).get(`/api/v1/reports/inventory/adjustments?factoryId=${T.plantA.id}&page=1&limit=50`);
    expect(report.status).toBe(200);
    expect(report.body.data.rows.length).toBeGreaterThan(0);
  });

  it('takes its own permission — a read-only user cannot adjust stock', async () => {
    const p = await product('Adj E', 'ADJ-E');
    const grn = await receive(T.plantA, p, 10);
    const res = await as(readOnly).post('/api/v1/inventory/adjustments', {
      factoryId: T.plantA.id, productId: p.id, lotId: grn.lines[0].lotId, countedQty: 8, reason: 'sneaky',
    });
    expect(res.status).toBe(403);
  });

  it('cannot adjust stock at a location the user has no access to', async () => {
    const p = await product('Adj F', 'ADJ-F');
    const grn = await receive(T.plantA, p, 10);
    const res = await as(plantBOnly).post('/api/v1/inventory/adjustments', {
      factoryId: T.plantA.id, productId: p.id, lotId: grn.lines[0].lotId, countedQty: 8, reason: 'wrong plant',
    });
    expect(res.status).toBe(403);
  });
});

// ===========================================================================
// F. Security
// ===========================================================================
describe('F. Security', () => {
  it('never leaks another tenant\'s lots or movements', async () => {
    const lots = await as(other.cookie).get('/api/v1/inventory/lots?limit=100');
    expect(lots.status).toBe(200);
    expect(lots.body.data.rows.every((r) => r.factoryId !== T.plantA.id)).toBe(true);

    const ledger = await as(other.cookie).get('/api/v1/inventory/ledger?limit=100');
    expect(ledger.body.data.rows.every((r) => r.factoryId !== T.plantA.id)).toBe(true);
  });

  it('confines a Plant-B user to Plant B stock', async () => {
    const lots = await as(plantBOnly).get('/api/v1/inventory/lots?limit=100');
    expect(lots.status).toBe(200);
    expect(lots.body.data.rows.some((r) => r.factoryId === T.plantA.id)).toBe(false);

    const ledger = await as(plantBOnly).get('/api/v1/inventory/ledger?limit=100');
    expect(ledger.body.data.rows.some((r) => r.factoryId === T.plantA.id)).toBe(false);

    const bal = await as(plantBOnly).get(`/api/v1/inventory/balance?factoryId=${T.plantA.id}&productId=${(await product('Sec A', 'SEC-A')).id}`);
    expect(bal.status).toBe(403);
  });

  it('requires authentication and INVENTORY_READ', async () => {
    expect((await request(app).get('/api/v1/inventory/lots')).status).toBe(401);
    expect((await as(readOnly).get('/api/v1/inventory/lots')).status).toBe(200);
  });
});

// ===========================================================================
// G. Reporting reconciles to the movements
// ===========================================================================
describe('G. Reporting', () => {
  const REPORTS = [
    ['Current Stock', 'inventory/current-stock'],
    ['Stock Movement', 'inventory/movement'],
    ['Stock Transfer', 'inventory/transfers'],
    ['Stock Adjustment', 'inventory/adjustments'],
    ['Stock Reconciliation', 'inventory/reconciliation'],
    ['Stock Ageing', 'ageing/stock-ageing'],
    ['Slow Moving', 'ageing/slow-moving'],
    ['Dead Stock', 'ageing/dead-stock'],
  ];

  it('serves every inventory report', async () => {
    for (const [label, path] of REPORTS) {
      const res = await as(admin).get(`/api/v1/reports/${path}?factoryId=${T.plantA.id}&page=1&limit=50`);
      expect([label, res.status]).toEqual([label, 200]);
    }
  });

  it('the reconciliation report shows no drift anywhere', async () => {
    const res = await as(admin).get(`/api/v1/reports/inventory/reconciliation?factoryId=${T.plantA.id}&page=1&limit=200`);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.summary.mismatchCount)).toBe(0);
  });

  it('current stock agrees with the ledger for a known product', async () => {
    const p = await product('Rpt A', 'RPT-A');
    await receive(T.plantA, p, 123);

    const res = await as(admin).get(`/api/v1/reports/inventory/current-stock?factoryId=${T.plantA.id}&search=RPT-A&page=1&limit=20`);
    expect(res.status).toBe(200);
    const row = res.body.data.rows.find((r) => r.productCode === 'RPT-A');
    expect(row).toBeDefined();
    // The identity the brief asks for: Opening + IN − OUT = Closing, and
    // Closing equals what the movement ledger says.
    expect(Number(row.openingStock) + Number(row.stockIn) - Number(row.stockOut)).toBe(Number(row.closingStock));
    expect(Number(row.closingStock)).toBe(await ledgerNet(T.plantA.id, p.id));
  });

  it('the movement report accounts for every movement of a product', async () => {
    const p = await product('Rpt B', 'RPT-B');
    const grn = await receive(T.plantA, p, 100);
    await as(admin).post('/api/v1/inventory/adjustments', {
      factoryId: T.plantA.id, productId: p.id, lotId: grn.lines[0].lotId, countedQty: 90, reason: 'count short',
    });

    const res = await as(admin).get(`/api/v1/reports/inventory/movement?factoryId=${T.plantA.id}&search=RPT-B&page=1&limit=50`);
    expect(res.status).toBe(200);
    const rows = res.body.data.rows.filter((r) => r.productCode === 'RPT-B');
    expect(rows.length).toBe(2); // the receipt and the adjustment
    const net = rows.reduce((s, r) => s + Number(r.quantityIn || 0) - Number(r.quantityOut || 0), 0);
    expect(net).toBe(await ledgerNet(T.plantA.id, p.id));
  });

  it('confines a Plant-B user\'s inventory reports to Plant B', async () => {
    expect((await as(plantBOnly).get(`/api/v1/reports/inventory/current-stock?factoryId=${T.plantA.id}&page=1&limit=20`)).status).toBe(403);
    const implicit = await as(plantBOnly).get('/api/v1/reports/inventory/current-stock?page=1&limit=100');
    expect(implicit.status).toBe(200);
    expect(JSON.stringify(implicit.body)).not.toContain(T.plantA.id);
  });
});
