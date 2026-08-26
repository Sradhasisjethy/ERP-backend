const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party,
  StockLot, StockLedgerEntry, MixDesign, MixDesignLine,
} = require('../src/models/index');
const { StockLedgerService } = require('../src/api/inventory/stockLedger.service');

/**
 * Inventory reconciliation.
 *
 * Drives one product through EVERY operation that can change stock, tracking
 * the expected balance by hand at each step, and then proves three things
 * agree at the end:
 *
 *   1. the hand-computed expectation,
 *   2. the sum of the immutable movement ledger,
 *   3. the derived per-lot balances the rest of the system reads.
 *
 * A PASS here is the only basis on which the stock numbers can be called
 * correct — everything else is an assertion about one code path.
 */

const PASSWORD = 'password123';
let cookie;
let C;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const get = (p) => request(app).get(p).set('Cookie', cookie);
const post = (p, b) => request(app).post(p).set('Cookie', cookie).send(b);
const put = (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {});

const ledgerNet = async (factoryId, productId) => {
  const rows = await StockLedgerEntry.findAll({ where: { factoryId, productId } });
  return rows.reduce((s, e) => s + (e.direction === 'IN' ? Number(e.quantity) : -Number(e.quantity)), 0);
};
const lotSum = async (factoryId, productId) => {
  const lots = await StockLot.findAll({ where: { factoryId, productId } });
  return lots.reduce((s, l) => s + Number(l.qtyAvailable), 0);
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Recon Co', slug: 'recon-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Recon Pvt Ltd', code: 'RC' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@recon.test', passwordHash, firstName: 'A', lastName: 'A', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const plantA = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant A', code: 'PA', state: 'Odisha', dispatchTolerancePercent: 0 });
  const plantB = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant B', code: 'PB', state: 'Odisha' });
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Supplier', state: 'Odisha' });
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Buyer', state: 'Odisha' });
  C = { tenantId, plantA, plantB, uom, vendor, customer };
  cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@recon.test', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('Inventory reconciliation — every mutation, one product', () => {
  let rm;
  let fg;
  let expected = 0;      // hand-tracked raw-material balance at Plant A
  let expectedFg = 0;    // hand-tracked finished-goods balance at Plant A
  const steps = [];
  let firstLotId;
  let secondGrnLotId;

  /** Records a step and asserts the ledger agrees with the running expectation. */
  const check = async (label, product, expectedQty) => {
    const net = await ledgerNet(C.plantA.id, product.id);
    const lots = await lotSum(C.plantA.id, product.id);
    steps.push({ label, expectedQty, net, lots });
    expect([label, net]).toEqual([label, expectedQty]);
    expect([label, lots]).toEqual([label, expectedQty]);
  };

  it('sets up a raw material, a finished good and a BOM', async () => {
    rm = (await post('/api/v1/products', { uomId: C.uom.id, name: 'Cement', code: 'RM-CEM', productType: 'RAW_MATERIAL' })).body.data;
    fg = (await post('/api/v1/products', { uomId: C.uom.id, name: 'Slab', code: 'FG-SLAB', productType: 'FINISHED_GOOD' })).body.data;
    const bom = await MixDesign.create({ tenantId: C.tenantId, productId: fg.id, name: 'Mix', version: 1, isActive: true, status: 'ACTIVE', effectiveFrom: '2026-04-01' });
    await MixDesignLine.create({ tenantId: C.tenantId, mixDesignId: bom.id, rawMaterialProductId: rm.id, quantityPerUnit: 2, uomId: C.uom.id });
    expect(rm.id && fg.id).toBeTruthy();
  });

  it('1. Purchase: +500', async () => {
    const grn = await post('/api/v1/purchasing/receipts', {
      factoryId: C.plantA.id, vendorPartyId: C.vendor.id, receiptDate: '2026-08-01',
      lines: [{ productId: rm.id, receivedQty: 500, ratePaise: 1000 }],
    });
    expect(grn.status).toBe(201);
    firstLotId = grn.body.data.lines[0].lotId;
    expected += 500;
    await check('purchase', rm, expected);
  });

  it('2. Second purchase: +200 (a separate lot, so FIFO has something to choose)', async () => {
    const grn = await post('/api/v1/purchasing/receipts', {
      factoryId: C.plantA.id, vendorPartyId: C.vendor.id, receiptDate: '2026-08-02',
      lines: [{ productId: rm.id, receivedQty: 200, ratePaise: 1000 }],
    });
    expect(grn.status).toBe(201);
    secondGrnLotId = grn.body.data.lines[0].lotId;
    expected += 200;
    await check('second purchase', rm, expected);
  });

  it('3. Purchase return: −50', async () => {
    const res = await post('/api/v1/returns/purchase-returns', {
      factoryId: C.plantA.id, vendorPartyId: C.vendor.id, returnDate: '2026-08-03', reason: 'damaged bags',
      lines: [{ productId: rm.id, lotId: firstLotId, quantity: 50, ratePaise: 1000 }],
    });
    expect(res.status).toBe(201);
    expected -= 50;
    await check('purchase return', rm, expected);
  });

  it('4. Production: raw material −200, finished goods +100', async () => {
    const entry = await post('/api/v1/production/entries', {
      factoryId: C.plantA.id, productId: fg.id, productionDate: '2026-08-04', goodQty: 100, rejectedQty: 0,
    });
    expect(entry.status).toBe(201);
    expected -= 200;   // 2 per unit × 100
    expectedFg += 100;
    await check('production consumption', rm, expected);
    await check('production output', fg, expectedFg);
  });

  it('5. Stock transfer out: −100 from Plant A (in transit, owned by neither)', async () => {
    const sent = await post('/api/v1/transfers', {
      fromFactoryId: C.plantA.id, toFactoryId: C.plantB.id, initiatedDate: '2026-08-05',
      lines: [{ productId: rm.id, sourceLotId: secondGrnLotId, quantity: 100 }],
    });
    expect(sent.status).toBe(201);
    expected -= 100;
    await check('transfer out', rm, expected);
    expect(await ledgerNet(C.plantB.id, rm.id)).toBe(0);

    const received = await put(`/api/v1/transfers/${sent.body.data.id}/receive`, {
      receivedDate: '2026-08-06',
      lines: [{ lineId: sent.body.data.lines[0].id, receivedQuantity: 100 }],
    });
    expect(received.status).toBe(200);
    // Plant A unchanged by the receipt; Plant B now holds it. Nothing created
    // or destroyed in the move.
    await check('transfer received (source unchanged)', rm, expected);
    expect(await ledgerNet(C.plantB.id, rm.id)).toBe(100);
  });

  it('6. Sale: finished goods −40', async () => {
    const order = await post('/api/v1/sales/orders', {
      factoryId: C.plantA.id, customerPartyId: C.customer.id, orderDate: '2026-08-07',
      lines: [{ productId: fg.id, orderedQty: 40, ratePaise: 5000 }],
    });
    const confirmed = await put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    // Reserving moves nothing.
    await check('reservation (no movement)', fg, expectedFg);

    const challan = await post('/api/v1/dispatch/challans', {
      salesOrderId: order.body.data.id, vehicleNumber: 'OD-01', dispatchDate: '2026-08-08',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 40 }],
    });
    expect(challan.status).toBe(201);
    expectedFg -= 40;
    await check('sale', fg, expectedFg);

    // Sales return of 10 puts stock back.
    const salesReturn = await post('/api/v1/returns/sales-returns', {
      factoryId: C.plantA.id, customerPartyId: C.customer.id, returnDate: '2026-08-09', reason: 'customer rejected 10',
      lines: [{ productId: fg.id, quantity: 10, ratePaise: 5000 }],
    });
    expect(salesReturn.status).toBe(201);
    expectedFg += 10;
    await check('sales return', fg, expectedFg);
  });

  it('7. Stock adjustment: a physical count correction', async () => {
    const before = await lotSum(C.plantA.id, rm.id);
    const lot = await StockLot.findOne({ where: { factoryId: C.plantA.id, productId: rm.id, qtyAvailable: { [require('sequelize').Op.gt]: 0 } } });

    const counted = Number(lot.qtyAvailable) - 7; // seven found broken
    const adj = await post('/api/v1/inventory/adjustments', {
      factoryId: C.plantA.id, productId: rm.id, lotId: lot.id, countedQty: counted,
      reason: 'Monthly physical count — 7 bags split',
    });
    expect(adj.status).toBe(201);
    expect(Number(adj.body.data.adjustmentQty)).toBe(-7);

    expected = before - 7;
    await check('adjustment', rm, expected);
  });

  it('8. Cancellation: reversing a receipt removes exactly what it added', async () => {
    const grn = await post('/api/v1/purchasing/receipts', {
      factoryId: C.plantA.id, vendorPartyId: C.vendor.id, receiptDate: '2026-08-10',
      lines: [{ productId: rm.id, receivedQty: 60, ratePaise: 1000 }],
    });
    expected += 60;
    await check('receipt before cancel', rm, expected);

    const cancelled = await put(`/api/v1/purchasing/receipts/${grn.body.data.id}/cancel`, { reason: 'delivered to wrong plant' });
    expect(cancelled.status).toBe(200);
    expected -= 60;
    await check('receipt cancelled', rm, expected);
  });

  it('RECONCILES: hand-tracked = movement ledger = derived balances, everywhere', async () => {
    // Per-product, at the factory we tracked by hand.
    expect(await ledgerNet(C.plantA.id, rm.id)).toBe(expected);
    expect(await lotSum(C.plantA.id, rm.id)).toBe(expected);
    expect(await ledgerNet(C.plantA.id, fg.id)).toBe(expectedFg);
    expect(await lotSum(C.plantA.id, fg.id)).toBe(expectedFg);

    // System-wide: no lot anywhere disagrees with its own movement history.
    const { checked, discrepancies } = await StockLedgerService.reconcileLedgerVsBalances();
    expect(checked).toBeGreaterThan(0);
    expect(discrepancies).toEqual([]);

    // Rebuilding every balance from the ledger changes nothing — the derived
    // projection is reproducible from the immutable record.
    const before = await StockLot.findAll({ attributes: ['id', 'qtyAvailable'], order: [['id', 'ASC']] });
    await StockLedgerService.rebuildStockBalances();
    const after = await StockLot.findAll({ attributes: ['id', 'qtyAvailable'], order: [['id', 'ASC']] });
    for (let i = 0; i < before.length; i += 1) {
      expect([before[i].id, Number(after[i].qtyAvailable)]).toEqual([before[i].id, Number(before[i].qtyAvailable)]);
    }

    // Raw material is conserved across locations: nothing vanished in transit.
    const totalRm = (await ledgerNet(C.plantA.id, rm.id)) + (await ledgerNet(C.plantB.id, rm.id));
    // 500 + 200 purchased − 50 returned − 200 consumed − 7 adjusted
    //   (+60 received then −60 reversed), all of it still somewhere.
    expect(totalRm).toBe(500 + 200 - 50 - 200 - 7);

    // eslint-disable-next-line no-console
    console.log('\n  Reconciliation trail:\n' + steps.map((s) => `    ${s.label.padEnd(34)} expected ${String(s.expectedQty).padStart(6)}  ledger ${String(s.net).padStart(6)}  balances ${String(s.lots).padStart(6)}`).join('\n'));
  });

  it('the Stock Reconciliation report agrees, with zero drift', async () => {
    const res = await get(`/api/v1/reports/inventory/reconciliation?factoryId=${C.plantA.id}&page=1&limit=200`);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.summary.mismatchCount)).toBe(0);

    const current = await get(`/api/v1/reports/inventory/current-stock?factoryId=${C.plantA.id}&page=1&limit=100`);
    const rmRow = current.body.data.rows.find((r) => r.productCode === 'RM-CEM');
    expect(Number(rmRow.openingStock) + Number(rmRow.stockIn) - Number(rmRow.stockOut)).toBe(Number(rmRow.closingStock));
    expect(Number(rmRow.closingStock)).toBe(await ledgerNet(C.plantA.id, rm.id));
  });
});
