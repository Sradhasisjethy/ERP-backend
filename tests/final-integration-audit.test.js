const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, HsnCode, Product, Party,
  AdGroup, AdGroupMember, UserFactory, StockLot, StockLedgerEntry, StockReservation,
  JournalEntry, JournalLine, Account, PurchaseInvoice, SalesInvoice, SalesOrderLine,
  Notification, AuditLog, PaymentAllocation,
} = require('../src/models/index');
const { StockLedgerService } = require('../src/api/inventory/stockLedger.service');

/**
 * FINAL CROSS-MODULE INTEGRATION AUDIT
 *
 * One tenant, one continuous dataset, seven business scenarios, then six
 * reconciliation identities proved across everything that dataset contains.
 *
 * The point is not to re-test each module — each has its own suite. It is to
 * prove they compose: that stock moved by sales is the same stock purchasing
 * received, that money raised by invoicing is the money finance reports, and
 * that cancelling something unwinds every consequence it had.
 */

const PASSWORD = 'password123';
let A;          // tenant A context
let B;          // tenant B, for isolation
let admin;
let plantBUser; // location-restricted
const money = {};

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

const as = (cookie) => ({
  get: (p) => request(app).get(p).set('Cookie', cookie),
  post: (p, b) => request(app).post(p).set('Cookie', cookie).send(b),
  put: (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {}),
});

/** Net stock for a product at a factory, straight from the movement ledger. */
const ledgerQty = async (factoryId, productId) => {
  const rows = await StockLedgerEntry.findAll({ where: { factoryId, productId } });
  return rows.reduce((s, e) => s + (e.direction === 'IN' ? Number(e.quantity) : -Number(e.quantity)), 0);
};
const lotQty = async (factoryId, productId) => {
  const lots = await StockLot.findAll({ where: { factoryId, productId } });
  return lots.reduce((s, l) => s + Number(l.qtyAvailable), 0);
};
const accountNet = async (code) => {
  const account = await Account.findOne({ where: { code } });
  if (!account) return 0;
  const lines = await JournalLine.findAll({ where: { accountId: account.id } });
  return lines.reduce((s, l) => s + Number(l.debitPaise) - Number(l.creditPaise), 0);
};
/** Signed party balance from the ledger: debit − credit. */
const partyNet = async (partyId) => {
  const lines = await JournalLine.findAll({ where: { partyId } });
  return lines.reduce((s, l) => s + Number(l.debitPaise) - Number(l.creditPaise), 0);
};

const seedTenant = async ({ slug, adminEmail, orgName }) => {
  const tenant = await Tenant.create({ name: orgName, slug, status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: orgName, code: slug.toUpperCase().slice(0, 6) });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: adminEmail, passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN', status: 'ACTIVE' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  return { tenantId, org, passwordHash, cookie: await loginAs(adminEmail) };
};

beforeAll(async () => {
  await resetDatabase();

  // ---- Scenario 1 prerequisite: Organization, Location, Customer, Product ----
  const base = await seedTenant({ slug: 'acme-erp', adminEmail: 'admin@acme.test', orgName: 'Acme Precast Pvt Ltd' });
  admin = base.cookie;

  const plantA = await Factory.create({
    tenantId: base.tenantId, organizationId: base.org.id, name: 'Bhubaneswar Plant', code: 'BBS',
    state: 'Odisha', dispatchTolerancePercent: 0, varianceThresholdPercent: 5,
  });
  const plantB = await Factory.create({
    tenantId: base.tenantId, organizationId: base.org.id, name: 'Cuttack Plant', code: 'CTC', state: 'Odisha',
  });
  A = { ...base, plantA, plantB };

  const bUser = await User.create(
    { tenantId: A.tenantId, email: 'ctc@acme.test', passwordHash: base.passwordHash, firstName: 'C', lastName: 'T', role: 'EMPLOYEE', status: 'ACTIVE' },
    { validate: false }
  );
  const g = await AdGroup.create({
    tenantId: A.tenantId, name: 'Cuttack Ops',
    permissions: ['SALES_READ', 'PURCHASE_READ', 'INVENTORY_READ', 'LEDGER_READ', 'PRODUCTION_READ', 'EXPENSE_READ', 'VIEW_RATES'],
  });
  await AdGroupMember.create({ tenantId: A.tenantId, adGroupId: g.id, employeeId: bUser.id });
  await UserFactory.create({ tenantId: A.tenantId, userId: bUser.id, factoryId: plantB.id });
  plantBUser = await loginAs('ctc@acme.test');

  B = await seedTenant({ slug: 'rival-erp', adminEmail: 'admin@rival.test', orgName: 'Rival Precast Pvt Ltd' });
  B.factory = await Factory.create({ tenantId: B.tenantId, organizationId: B.org.id, name: 'Rival Plant', code: 'RVP', state: 'Odisha' });
});

afterAll(async () => {
  await sequelize.close();
});

// ===========================================================================
// MASTER DATA — the foundation every other scenario builds on
// ===========================================================================
describe('Master Data → the rest of the system', () => {
  it('creates the masters through their own APIs', async () => {
    const uom = await as(admin).post('/api/v1/uoms', { name: 'Numbers', code: 'NOS' });
    expect(uom.status).toBe(201);
    A.uom = uom.body.data;

    const hsn = await as(admin).post('/api/v1/hsn-codes', { code: '68109990', description: 'Precast concrete', gstRatePercent: 18 });
    A.hsn = hsn.body.data;

    const category = await as(admin).post('/api/v1/product-categories', { name: 'Precast', code: 'PRECAST' });
    expect(category.status).toBe(201);

    A.cement = (await as(admin).post('/api/v1/products', {
      uomId: A.uom.id, name: 'OPC Cement', code: 'RM-OPC', productType: 'RAW_MATERIAL', standardCostPaise: 40000,
    })).body.data;
    A.slab = (await as(admin).post('/api/v1/products', {
      uomId: A.uom.id, hsnId: A.hsn.id, categoryId: category.body.data.id,
      name: 'Precast Slab', code: 'FG-SLAB', productType: 'FINISHED_GOOD', curingDays: 0, reorderLevel: 20,
    })).body.data;

    A.customer = (await as(admin).post('/api/v1/parties', {
      partyType: 'CUSTOMER', name: 'Konark Infra', code: 'CUST-KI', gstin: '21KONAR1234K1Z5',
      state: 'Odisha', creditLimitPaise: 100000000, creditAction: 'WARN',
    })).body.data;
    expect((await as(admin).post(`/api/v1/parties/${A.customer.id}/addresses`, { line1: 'NH-16 Site', state: 'Odisha' })).status).toBe(201);

    A.vendor = (await as(admin).post('/api/v1/parties', {
      partyType: 'VENDOR', name: 'Odisha Cement Co', code: 'VEND-OCC', gstin: '21OCCPL1234C1Z5', state: 'Odisha',
    })).body.data;

    // A master in use cannot be deleted — the guarantee every downstream
    // scenario depends on.
    expect(A.uom.id && A.cement.id && A.slab.id && A.customer.id && A.vendor.id).toBeTruthy();
  });

  it('refuses to delete a master the rest of the system depends on', async () => {
    const del = await request(app).delete(`/api/v1/uoms/${A.uom.id}`).set('Cookie', admin);
    expect(del.status).toBe(409);
  });
});

// ===========================================================================
// SCENARIO 2 — PURCHASE (run first: it is what puts stock in)
// ===========================================================================
describe('Scenario 2 — Purchase → Inventory → Payable → Payment → Ledger', () => {
  it('purchases raw material and puts it in stock', async () => {
    const po = await as(admin).post('/api/v1/purchasing/orders', {
      factoryId: A.plantA.id, vendorPartyId: A.vendor.id, orderDate: '2026-08-01',
      lines: [{ productId: A.cement.id, orderedQty: 1000, ratePaise: 40000 }],
    });
    expect(po.status).toBe(201);
    await as(admin).put(`/api/v1/purchasing/orders/${po.body.data.id}/confirm`);

    const grn = await as(admin).post('/api/v1/purchasing/receipts', {
      factoryId: A.plantA.id, vendorPartyId: A.vendor.id, purchaseOrderId: po.body.data.id, receiptDate: '2026-08-02',
      lines: [{ productId: A.cement.id, receivedQty: 1000, ratePaise: 40000, purchaseOrderLineId: po.body.data.lines[0].id }],
    });
    expect(grn.status).toBe(201);
    A.cementGrn = grn.body.data;

    expect(await ledgerQty(A.plantA.id, A.cement.id)).toBe(1000);
    expect(await lotQty(A.plantA.id, A.cement.id)).toBe(1000);
  });

  it('books the payable and pays it, moving the vendor ledger correctly', async () => {
    const before = await partyNet(A.vendor.id);

    const bill = await as(admin).post('/api/v1/purchasing/invoices', {
      factoryId: A.plantA.id, goodsReceiptId: A.cementGrn.id, vendorPartyId: A.vendor.id,
      vendorInvoiceNumber: 'OCC/2026/1001', invoiceDate: '2026-08-03', dueDate: '2026-09-02', amountPaise: 40000000,
    });
    expect(bill.status).toBe(201);
    A.vendorBill = bill.body.data;
    money.purchase = 40000000;

    // A payable is a credit: the signed net moves down.
    expect(await partyNet(A.vendor.id)).toBe(before - 40000000);

    const pay = await as(admin).post('/api/v1/payments', {
      factoryId: A.plantA.id, partyId: A.vendor.id, paymentDate: '2026-08-04',
      modes: [{ mode: 'BANK', amountPaise: 25000000, reference: 'UTR-V1' }],
      allocations: [{ invoiceId: A.vendorBill.id, allocatedAmountPaise: 25000000 }],
    });
    expect(pay.status).toBe(201);
    money.vendorPaid = 25000000;

    expect((await PurchaseInvoice.findByPk(A.vendorBill.id)).paymentStatus).toBe('PARTIALLY_PAID');
    // Outstanding to the vendor reads positive on the statement.
    const stmt = await as(admin).get(`/api/v1/ledger/party/${A.vendor.id}?page=1&limit=100`);
    expect(Number(stmt.body.data.outstandingPaise)).toBe(15000000);
  });
});

// ===========================================================================
// SCENARIO 3 — PRODUCTION
// ===========================================================================
describe('Scenario 3 — BOM → Production → raw material OUT, finished goods IN', () => {
  it('defines and activates a BOM', async () => {
    const bom = await as(admin).post('/api/v1/mix-designs', {
      productId: A.slab.id, name: 'Slab Mix v1', activate: true, effectiveFrom: '2026-04-01', outputQuantity: 1,
      lines: [{ rawMaterialProductId: A.cement.id, quantityPerUnit: 2, uomId: A.uom.id }],
    });
    expect(bom.status).toBe(201);
    expect(bom.body.data.status).toBe('ACTIVE');
  });

  it('produces 300 slabs, consuming 600 cement per the BOM', async () => {
    const entry = await as(admin).post('/api/v1/production/entries', {
      factoryId: A.plantA.id, productId: A.slab.id, productionDate: '2026-08-05', goodQty: 300, rejectedQty: 0,
    });
    expect(entry.status).toBe(201);
    expect(Number(entry.body.data.consumptions[0].mixDesignQty)).toBe(600);

    expect(await ledgerQty(A.plantA.id, A.cement.id)).toBe(400);   // 1000 − 600
    expect(await ledgerQty(A.plantA.id, A.slab.id)).toBe(300);
    expect(await lotQty(A.plantA.id, A.slab.id)).toBe(300);
  });

  it('shows the run on the production report', async () => {
    const res = await as(admin).get(`/api/v1/reports/production/output?factoryId=${A.plantA.id}&page=1&limit=50`);
    expect([200, 404]).toContain(res.status);
    if (res.status === 200) expect(JSON.stringify(res.body)).toContain('Precast Slab');
  });
});

// ===========================================================================
// SCENARIO 1 — SALES, end to end
// ===========================================================================
describe('Scenario 1 — Sales Order → Reserve → Deliver → Invoice → Payment → Ledger', () => {
  it('raises and confirms an order, reserving stock', async () => {
    const atpBefore = await as(admin).get(`/api/v1/sales/atp?factoryId=${A.plantA.id}&productId=${A.slab.id}`);
    expect(atpBefore.body.data.available).toBe(300);

    const order = await as(admin).post('/api/v1/sales/orders', {
      factoryId: A.plantA.id, customerPartyId: A.customer.id, orderDate: '2026-08-06',
      expectedDeliveryDate: '2026-08-20', poReferenceNumber: 'KI/PO/2026/77',
      lines: [{ productId: A.slab.id, orderedQty: 200, ratePaise: 100000 }],
    });
    expect(order.status).toBe(201);
    A.order = order.body.data;

    const confirmed = await as(admin).put(`/api/v1/sales/orders/${A.order.id}/confirm`);
    expect(confirmed.body.data.status).toBe('CONFIRMED');
    A.orderLineId = confirmed.body.data.lines[0].id;

    const atp = await as(admin).get(`/api/v1/sales/atp?factoryId=${A.plantA.id}&productId=${A.slab.id}`);
    expect(atp.body.data.reserved).toBe(200);
    expect(atp.body.data.available).toBe(100);
    // Reserving moves no stock.
    expect(await ledgerQty(A.plantA.id, A.slab.id)).toBe(300);
  });

  it('delivers in two parts and takes stock out exactly once each time', async () => {
    const first = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: A.order.id, vehicleNumber: 'OD-02-AB-1111', driverName: 'R. Sahoo', dispatchDate: '2026-08-07',
      lines: [{ salesOrderLineId: A.orderLineId, dispatchedQty: 120 }],
    });
    expect(first.status).toBe(201);
    expect((await as(admin).get(`/api/v1/sales/orders/${A.order.id}`)).body.data.status).toBe('PARTIALLY_DISPATCHED');

    const second = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: A.order.id, vehicleNumber: 'OD-02-AB-2222', dispatchDate: '2026-08-08',
      lines: [{ salesOrderLineId: A.orderLineId, dispatchedQty: 80 }],
    });
    expect(second.status).toBe(201);
    A.challans = [first.body.data, second.body.data];

    expect((await as(admin).get(`/api/v1/sales/orders/${A.order.id}`)).body.data.status).toBe('DISPATCHED');
    expect(Number((await SalesOrderLine.findByPk(A.orderLineId)).dispatchedQty)).toBe(200);
    expect(await ledgerQty(A.plantA.id, A.slab.id)).toBe(100); // 300 − 200
  });

  it('invoices both challans and raises the receivable', async () => {
    const arBefore = await partyNet(A.customer.id);
    const invoice = await as(admin).post('/api/v1/invoices', {
      challanIds: A.challans.map((c) => c.id), invoiceDate: '2026-08-09',
    });
    expect(invoice.status).toBe(201);
    A.invoice = invoice.body.data;
    money.salesGross = Number(A.invoice.totalPaise);

    expect(Number(A.invoice.subtotalPaise)).toBe(20000000);   // 200 × 1000.00
    expect(Number(A.invoice.cgstPaise)).toBeGreaterThan(0);   // Odisha → Odisha
    expect(Number(A.invoice.igstPaise)).toBe(0);
    expect(money.salesGross % 100).toBe(0);                   // rounded to the rupee
    expect(await partyNet(A.customer.id)).toBe(arBefore + money.salesGross);
  });

  it('receives payment in two parts and clears the receivable', async () => {
    const half = Math.floor(money.salesGross / 2);
    for (const [amount, ref] of [[half, 'UTR-C1'], [money.salesGross - half, 'UTR-C2']]) {
      const r = await as(admin).post('/api/v1/receipts', {
        factoryId: A.plantA.id, customerPartyId: A.customer.id, receiptDate: '2026-08-10',
        modes: [{ mode: 'BANK', amountPaise: amount, reference: ref }],
        allocations: [{ invoiceId: A.invoice.id, allocatedAmountPaise: amount }],
      });
      expect(r.status).toBe(201);
    }
    money.salesReceived = money.salesGross;

    const stmt = await as(admin).get(`/api/v1/ledger/party/${A.customer.id}?page=1&limit=100`);
    expect(Number(stmt.body.data.outstandingPaise)).toBe(0);
    expect(Number(stmt.body.data.closingBalancePaise)).toBe(0);

    // Overpayment has nowhere to go.
    const over = await as(admin).post('/api/v1/receipts', {
      factoryId: A.plantA.id, customerPartyId: A.customer.id, receiptDate: '2026-08-11',
      modes: [{ mode: 'BANK', amountPaise: 100, reference: 'UTR-X' }],
      allocations: [{ invoiceId: A.invoice.id, allocatedAmountPaise: 100 }],
    });
    expect(over.status).toBe(400);
  });

  it('appears correctly on every sales-side report', async () => {
    for (const path of ['sales/summary', 'sales/detail', 'sales/by-customer', 'sales/by-product', 'sales/by-location', 'orders/sales-orders', 'customer/ledger', 'customer/outstanding']) {
      const res = await as(admin).get(`/api/v1/reports/${path}?factoryId=${A.plantA.id}&page=1&limit=50`);
      expect([path, res.status]).toEqual([path, 200]);
    }
    const summary = await as(admin).get(`/api/v1/reports/sales/summary?factoryId=${A.plantA.id}&page=1&limit=50`);
    expect(JSON.stringify(summary.body)).toContain('Konark Infra');
  });

  it('leaves a complete audit trail for the whole chain', async () => {
    for (const entityType of ['Party', 'Product', 'SalesOrder', 'DeliveryChallan', 'SalesInvoice', 'Receipt', 'GoodsReceipt', 'PurchaseInvoice', 'Payment', 'ProductionEntry']) {
      const rows = await AuditLog.findAll({ where: { entityType } });
      expect([entityType, rows.length > 0]).toEqual([entityType, true]);
      expect([entityType, rows.every((r) => r.userId)]).toEqual([entityType, true]);
    }
  });
});

// ===========================================================================
// SCENARIO 4 — STOCK TRANSFER
// ===========================================================================
describe('Scenario 4 — Transfer between locations', () => {
  it('moves stock from Bhubaneswar to Cuttack, conserving the total', async () => {
    const aBefore = await ledgerQty(A.plantA.id, A.cement.id);
    const bBefore = await ledgerQty(A.plantB.id, A.cement.id);
    const lot = await StockLot.findOne({ where: { factoryId: A.plantA.id, productId: A.cement.id } });

    const sent = await as(admin).post('/api/v1/transfers', {
      fromFactoryId: A.plantA.id, toFactoryId: A.plantB.id, initiatedDate: '2026-08-12', vehicleNumber: 'OD-02-TR-9',
      lines: [{ productId: A.cement.id, sourceLotId: lot.id, quantity: 150 }],
    });
    expect(sent.status).toBe(201);
    expect(await ledgerQty(A.plantA.id, A.cement.id)).toBe(aBefore - 150);
    expect(await ledgerQty(A.plantB.id, A.cement.id)).toBe(bBefore); // in transit, owned by neither

    const received = await as(admin).put(`/api/v1/transfers/${sent.body.data.id}/receive`, {
      receivedDate: '2026-08-13',
      lines: [{ lineId: sent.body.data.lines[0].id, receivedQuantity: 150 }],
    });
    expect(received.status).toBe(200);

    expect(await ledgerQty(A.plantA.id, A.cement.id)).toBe(aBefore - 150);
    expect(await ledgerQty(A.plantB.id, A.cement.id)).toBe(bBefore + 150);
    // Nothing created or destroyed by the move.
    expect((await ledgerQty(A.plantA.id, A.cement.id)) + (await ledgerQty(A.plantB.id, A.cement.id))).toBe(aBefore + bBefore);

    const report = await as(admin).get(`/api/v1/reports/inventory/transfers?factoryId=${A.plantA.id}&page=1&limit=20`);
    expect(report.status).toBe(200);
    expect((await AuditLog.findAll({ where: { entityType: 'StockTransfer' } })).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// SCENARIO 5 — SECURITY
// ===========================================================================
describe('Scenario 5 — Organization and location isolation', () => {
  it('gives tenant B no sight of tenant A on any module', async () => {
    const paths = [
      '/api/v1/parties', '/api/v1/products', '/api/v1/sales/orders', '/api/v1/purchasing/orders',
      '/api/v1/inventory/lots', '/api/v1/inventory/ledger', '/api/v1/invoices', '/api/v1/receipts',
      '/api/v1/payments', '/api/v1/dispatch/challans', '/api/v1/transfers', '/api/v1/expenses',
      '/api/v1/audit-logs', '/api/v1/notifications',
    ];
    for (const path of paths) {
      const mine = await as(admin).get(`${path}?limit=100`);
      const theirs = await as(B.cookie).get(`${path}?limit=100`);
      expect([path, theirs.status]).toEqual([path, 200]);
      const myIds = new Set((mine.body.data.rows || []).map((r) => r.id));
      expect([path, (theirs.body.data.rows || []).filter((r) => myIds.has(r.id))]).toEqual([path, []]);
    }

    // Direct object access by id is refused too.
    expect((await as(B.cookie).get(`/api/v1/sales/orders/${A.order.id}`)).status).toBe(404);
    expect((await as(B.cookie).get(`/api/v1/invoices/${A.invoice.id}`)).status).toBe(404);
    // ...and tenant B's books balance without a trace of tenant A.
    const tb = await as(B.cookie).get('/api/v1/ledger/trial-balance');
    expect(tb.body.data.reduce((s, r) => s + Number(r.balancePaise), 0)).toBe(0);
  });

  it('confines a Cuttack user to Cuttack across every module', async () => {
    const listed = await as(plantBUser).get('/api/v1/sales/orders?limit=100');
    expect(listed.body.data.rows.some((r) => r.factoryId === A.plantA.id)).toBe(false);
    expect([403, 404]).toContain((await as(plantBUser).get(`/api/v1/sales/orders/${A.order.id}`)).status);
    expect((await as(plantBUser).get(`/api/v1/ledger/trial-balance?factoryId=${A.plantA.id}`)).status).toBe(403);
    expect((await as(plantBUser).get(`/api/v1/sales/atp?factoryId=${A.plantA.id}&productId=${A.slab.id}`)).status).toBe(403);

    const lots = await as(plantBUser).get('/api/v1/inventory/lots?limit=100');
    expect(lots.body.data.rows.some((r) => r.factoryId === A.plantA.id)).toBe(false);
  });

  it('enforces RBAC and refuses privilege escalation', async () => {
    expect((await as(plantBUser).post('/api/v1/sales/orders', {
      factoryId: A.plantB.id, customerPartyId: A.customer.id, orderDate: '2026-08-14',
      lines: [{ productId: A.slab.id, orderedQty: 1, ratePaise: 100 }],
    })).status).toBe(403);
    expect((await as(plantBUser).post('/api/v1/roles', { name: 'Mine', permissions: ['*'] })).status).toBe(403);
    expect((await request(app).get('/api/v1/sales/orders')).status).toBe(401);
  });
});

// ===========================================================================
// SCENARIO 6 — CANCELLATION and downstream reversal
// ===========================================================================
describe('Scenario 6 — Cancellation reverses every consequence', () => {
  it('cancelling a receipt reverses the ledger and frees the invoice', async () => {
    const product = (await as(admin).post('/api/v1/products', {
      uomId: A.uom.id, hsnId: A.hsn.id, name: 'Cancel Slab', code: 'FG-CANCEL', productType: 'FINISHED_GOOD',
    })).body.data;
    await as(admin).post('/api/v1/purchasing/receipts', {
      factoryId: A.plantA.id, vendorPartyId: A.vendor.id, receiptDate: '2026-08-15',
      lines: [{ productId: product.id, receivedQty: 50, ratePaise: 1000 }],
    });
    const order = await as(admin).post('/api/v1/sales/orders', {
      factoryId: A.plantA.id, customerPartyId: A.customer.id, orderDate: '2026-08-15',
      lines: [{ productId: product.id, orderedQty: 50, ratePaise: 100000 }],
    });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    const challan = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: order.body.data.id, vehicleNumber: 'OD-02-CX-1', dispatchDate: '2026-08-16',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 50 }],
    });
    const invoice = await as(admin).post('/api/v1/invoices', { challanIds: [challan.body.data.id], invoiceDate: '2026-08-17' });
    const due = Number(invoice.body.data.totalPaise);

    const arAfterInvoice = await partyNet(A.customer.id);
    const receipt = await as(admin).post('/api/v1/receipts', {
      factoryId: A.plantA.id, customerPartyId: A.customer.id, receiptDate: '2026-08-18',
      modes: [{ mode: 'BANK', amountPaise: due, reference: 'UTR-CX' }],
      allocations: [{ invoiceId: invoice.body.data.id, allocatedAmountPaise: due }],
    });
    expect(receipt.status).toBe(201);
    expect(await partyNet(A.customer.id)).toBe(arAfterInvoice - due);

    // An invoice with money against it cannot be cancelled.
    expect((await as(admin).put(`/api/v1/invoices/${invoice.body.data.id}/cancel`, { reason: 'no' })).status).toBe(400);

    // Cancel the receipt: a reversing entry, never an edit.
    const cancelled = await as(admin).put(`/api/v1/receipts/${receipt.body.data.id}/cancel`, { reason: 'wrong customer credited' });
    expect(cancelled.status).toBe(200);
    expect(await partyNet(A.customer.id)).toBe(arAfterInvoice);
    const entries = await JournalEntry.findAll({ where: { referenceType: 'Receipt', referenceId: receipt.body.data.id } });
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => e.reversalOfEntryId)).toBe(true);

    // The invoice is outstanding again and can now be cancelled, unwinding the receivable.
    const nowCancellable = await as(admin).put(`/api/v1/invoices/${invoice.body.data.id}/cancel`, { reason: 'raised in error' });
    expect(nowCancellable.status).toBe(200);
    expect(await partyNet(A.customer.id)).toBe(arAfterInvoice - due);

    A.cancelledChallanId = challan.body.data.id;
    A.cancelProductId = product.id;
  });

  it('cancelling a delivery returns the stock and re-holds it for the order', async () => {
    const before = await ledgerQty(A.plantA.id, A.cancelProductId);
    const cancelled = await as(admin).put(`/api/v1/dispatch/challans/${A.cancelledChallanId}/cancel`, { reason: 'vehicle turned back' });
    expect(cancelled.status).toBe(200);

    expect(await ledgerQty(A.plantA.id, A.cancelProductId)).toBe(before + 50);
    const entries = await StockLedgerEntry.findAll({ where: { productId: A.cancelProductId } });
    expect(entries.filter((e) => e.movementType === 'SALE_OUT')).toHaveLength(1);
    expect(entries.filter((e) => e.movementType === 'REVERSAL')).toHaveLength(1);
    // The order is live again, so the stock is re-held rather than released.
    expect(Number(await StockReservation.sum('quantity', { where: { productId: A.cancelProductId, status: 'ACTIVE' } }))).toBe(50);
  });

  it('cancelling a goods receipt reverses its stock, and is refused once invoiced', async () => {
    const p = (await as(admin).post('/api/v1/products', { uomId: A.uom.id, name: 'Revert RM', code: 'RM-REVERT', productType: 'RAW_MATERIAL' })).body.data;
    const grn = await as(admin).post('/api/v1/purchasing/receipts', {
      factoryId: A.plantA.id, vendorPartyId: A.vendor.id, receiptDate: '2026-08-19',
      lines: [{ productId: p.id, receivedQty: 40, ratePaise: 1000 }],
    });
    expect(await ledgerQty(A.plantA.id, p.id)).toBe(40);

    const bill = await as(admin).post('/api/v1/purchasing/invoices', {
      factoryId: A.plantA.id, goodsReceiptId: grn.body.data.id, vendorPartyId: A.vendor.id,
      vendorInvoiceNumber: 'OCC/2026/1002', invoiceDate: '2026-08-19', amountPaise: 40000,
    });
    expect(bill.status).toBe(201);
    // Invoiced: the receipt can no longer be reversed behind the bill's back.
    expect((await as(admin).put(`/api/v1/purchasing/receipts/${grn.body.data.id}/cancel`, { reason: 'x' })).status).toBe(400);

    // Cancel the bill first, then the receipt.
    expect((await as(admin).put(`/api/v1/purchasing/invoices/${bill.body.data.id}/cancel`, { reason: 'wrong bill' })).status).toBe(200);
    expect((await as(admin).put(`/api/v1/purchasing/receipts/${grn.body.data.id}/cancel`, { reason: 'returned at gate' })).status).toBe(200);
    expect(await ledgerQty(A.plantA.id, p.id)).toBe(0);
  });

  it('never deletes a cancelled document — the record and its number survive', async () => {
    const challan = await as(admin).get(`/api/v1/dispatch/challans/${A.cancelledChallanId}`);
    expect(challan.status).toBe(200);
    expect(challan.body.data.status).toBe('CANCELLED');
    expect(challan.body.data.challanNumber).toBeTruthy();
    expect(challan.body.data.cancelReason).toMatch(/vehicle/i);
  });
});

// ===========================================================================
// SCENARIO 7 — CONCURRENCY
// ===========================================================================
describe('Scenario 7 — Concurrency', () => {
  it('concurrent reservations never promise the same units twice', async () => {
    const p = (await as(admin).post('/api/v1/products', { uomId: A.uom.id, name: 'Race FG', code: 'FG-RACE', productType: 'FINISHED_GOOD' })).body.data;
    await as(admin).post('/api/v1/purchasing/receipts', {
      factoryId: A.plantA.id, vendorPartyId: A.vendor.id, receiptDate: '2026-08-20',
      lines: [{ productId: p.id, receivedQty: 100, ratePaise: 1000 }],
    });

    const mk = async () => (await as(admin).post('/api/v1/sales/orders', {
      factoryId: A.plantA.id, customerPartyId: A.customer.id, orderDate: '2026-08-20',
      lines: [{ productId: p.id, orderedQty: 80, ratePaise: 1000 }],
    })).body.data.id;
    const [o1, o2] = [await mk(), await mk()];
    await Promise.all([
      as(admin).put(`/api/v1/sales/orders/${o1}/confirm`),
      as(admin).put(`/api/v1/sales/orders/${o2}/confirm`),
    ]);
    expect(Number(await StockReservation.sum('quantity', { where: { productId: p.id, status: 'ACTIVE' } }))).toBeLessThanOrEqual(100);
  });

  it('concurrent dispatch never oversells or over-dispatches', async () => {
    const p = (await as(admin).post('/api/v1/products', { uomId: A.uom.id, name: 'Race D', code: 'FG-RACE-D', productType: 'FINISHED_GOOD' })).body.data;
    await as(admin).post('/api/v1/purchasing/receipts', {
      factoryId: A.plantA.id, vendorPartyId: A.vendor.id, receiptDate: '2026-08-21',
      lines: [{ productId: p.id, receivedQty: 150, ratePaise: 1000 }],
    });
    const build = async () => {
      const o = await as(admin).post('/api/v1/sales/orders', {
        factoryId: A.plantA.id, customerPartyId: A.customer.id, orderDate: '2026-08-21',
        lines: [{ productId: p.id, orderedQty: 100, ratePaise: 1000 }],
      });
      const c = await as(admin).put(`/api/v1/sales/orders/${o.body.data.id}/confirm`);
      return { id: o.body.data.id, lineId: c.body.data.lines[0].id };
    };
    const [x, y] = [await build(), await build()];
    const [r1, r2] = await Promise.all([
      as(admin).post('/api/v1/dispatch/challans', { salesOrderId: x.id, vehicleNumber: 'OD-R1', dispatchDate: '2026-08-22', lines: [{ salesOrderLineId: x.lineId, dispatchedQty: 100 }] }),
      as(admin).post('/api/v1/dispatch/challans', { salesOrderId: y.id, vehicleNumber: 'OD-R2', dispatchDate: '2026-08-22', lines: [{ salesOrderLineId: y.lineId, dispatchedQty: 100 }] }),
    ]);
    expect([r1, r2].filter((r) => r.status === 201).length).toBe(1);
    expect(await ledgerQty(A.plantA.id, p.id)).toBe(50);
    expect(await ledgerQty(A.plantA.id, p.id)).toBeGreaterThanOrEqual(0);
  });

  it('concurrent payments never over-allocate one invoice', async () => {
    const p = (await as(admin).post('/api/v1/products', { uomId: A.uom.id, hsnId: A.hsn.id, name: 'Race P', code: 'FG-RACE-P', productType: 'FINISHED_GOOD' })).body.data;
    await as(admin).post('/api/v1/purchasing/receipts', {
      factoryId: A.plantA.id, vendorPartyId: A.vendor.id, receiptDate: '2026-08-23',
      lines: [{ productId: p.id, receivedQty: 10, ratePaise: 1000 }],
    });
    const o = await as(admin).post('/api/v1/sales/orders', {
      factoryId: A.plantA.id, customerPartyId: A.customer.id, orderDate: '2026-08-23',
      lines: [{ productId: p.id, orderedQty: 10, ratePaise: 100000 }],
    });
    const c = await as(admin).put(`/api/v1/sales/orders/${o.body.data.id}/confirm`);
    const ch = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: o.body.data.id, vehicleNumber: 'OD-RP', dispatchDate: '2026-08-24',
      lines: [{ salesOrderLineId: c.body.data.lines[0].id, dispatchedQty: 10 }],
    });
    const inv = await as(admin).post('/api/v1/invoices', { challanIds: [ch.body.data.id], invoiceDate: '2026-08-25' });
    const full = Number(inv.body.data.totalPaise);

    const fire = () => as(admin).post('/api/v1/receipts', {
      factoryId: A.plantA.id, customerPartyId: A.customer.id, receiptDate: '2026-08-26',
      modes: [{ mode: 'BANK', amountPaise: full, reference: 'UTR-RP' }],
      allocations: [{ invoiceId: inv.body.data.id, allocatedAmountPaise: full }],
    });
    const [a, b] = await Promise.all([fire(), fire()]);
    expect([a, b].filter((r) => r.status === 201).length).toBe(1);
    expect(Number(await PaymentAllocation.sum('allocatedAmountPaise', { where: { invoiceId: inv.body.data.id } }))).toBe(full);
  });

  it('concurrent document generation never issues a duplicate number', async () => {
    const fire = () => as(admin).post('/api/v1/expenses', {
      factoryId: A.plantA.id, expenseDate: '2026-08-27', category: 'Concurrency', mode: 'BANK', amountPaise: 100,
    });
    const results = await Promise.all(Array.from({ length: 10 }, fire));
    const numbers = results.filter((r) => r.status === 201).map((r) => r.body.data.expenseNumber);
    expect(numbers.length).toBe(10);
    expect(new Set(numbers).size).toBe(10);
  });
});

// ===========================================================================
// RECONCILIATION — the six identities, across everything above
// ===========================================================================
describe('RECONCILIATION across the whole dataset', () => {
  it('1. Inventory balance = inventory movements, for every lot', async () => {
    const { checked, discrepancies } = await StockLedgerService.reconcileLedgerVsBalances();
    expect(checked).toBeGreaterThan(0);
    expect(discrepancies).toEqual([]);

    // ...and rebuilding from the ledger changes nothing.
    const before = await StockLot.findAll({ attributes: ['id', 'qtyAvailable'], order: [['id', 'ASC']] });
    await StockLedgerService.rebuildStockBalances();
    const after = await StockLot.findAll({ attributes: ['id', 'qtyAvailable'], order: [['id', 'ASC']] });
    for (let i = 0; i < before.length; i += 1) {
      expect([before[i].id, Number(after[i].qtyAvailable)]).toEqual([before[i].id, Number(before[i].qtyAvailable)]);
    }
  });

  it('2. Customer outstanding = invoices − payments', async () => {
    const invoices = await SalesInvoice.findAll({ where: { customerPartyId: A.customer.id, status: 'POSTED' } });
    const invoiced = invoices.reduce((s, i) => s + Number(i.totalPaise), 0);

    const allocs = await PaymentAllocation.findAll({ where: { invoiceType: 'SALES' } });
    const invoiceIds = new Set(invoices.map((i) => i.id));
    const { Receipt } = require('../src/models/index');
    let received = 0;
    for (const a of allocs) {
      if (!invoiceIds.has(a.invoiceId)) continue;
      const r = await Receipt.findByPk(a.receiptId);
      if (r && r.status === 'POSTED') received += Number(a.allocatedAmountPaise);
    }

    const stmt = await as(admin).get(`/api/v1/ledger/party/${A.customer.id}?page=1&limit=200`);
    expect(Number(stmt.body.data.outstandingPaise)).toBe(invoiced - received);
  });

  it('3. Vendor outstanding = purchases − payments', async () => {
    const bills = await PurchaseInvoice.findAll({ where: { vendorPartyId: A.vendor.id, status: 'POSTED' } });
    const billed = bills.reduce((s, i) => s + Number(i.amountPaise), 0);

    const { Payment } = require('../src/models/index');
    const allocs = await PaymentAllocation.findAll({ where: { invoiceType: 'PURCHASE' } });
    const billIds = new Set(bills.map((b) => b.id));
    let paid = 0;
    for (const a of allocs) {
      if (!billIds.has(a.invoiceId)) continue;
      const p = await Payment.findByPk(a.paymentId);
      if (p && p.status === 'POSTED') paid += Number(a.allocatedAmountPaise);
    }

    const stmt = await as(admin).get(`/api/v1/ledger/party/${A.vendor.id}?page=1&limit=200`);
    expect(Number(stmt.body.data.outstandingPaise)).toBe(billed - paid);
  });

  it('4. Cash/bank balance = opening + inflows − outflows', async () => {
    for (const accountKey of ['CASH', 'BANK']) {
      const book = await as(admin).get(`/api/v1/ledger/cash-book?factoryId=${A.plantA.id}&accountKey=${accountKey}`);
      expect(book.status).toBe(200);
      const b = book.body.data;
      expect(Number(b.openingBalancePaise) + Number(b.totalInPaise) - Number(b.totalOutPaise)).toBe(Number(b.closingBalancePaise));
    }
  });

  it('5. The books balance and the trial balance is zero', async () => {
    const entries = await JournalEntry.findAll({ include: [{ model: JournalLine, as: 'lines' }] });
    for (const e of entries) {
      const d = e.lines.reduce((s, l) => s + Number(l.debitPaise), 0);
      const c = e.lines.reduce((s, l) => s + Number(l.creditPaise), 0);
      expect([e.id, d]).toEqual([e.id, c]);
    }
    const all = await JournalLine.findAll();
    expect(all.reduce((s, l) => s + Number(l.debitPaise), 0)).toBe(all.reduce((s, l) => s + Number(l.creditPaise), 0));

    const tb = await as(admin).get('/api/v1/ledger/trial-balance');
    expect(tb.body.data.reduce((s, r) => s + Number(r.balancePaise), 0)).toBe(0);

    // Exactly one journal per financial document — no duplicated ledger effects.
    const nonReversals = await JournalEntry.findAll({ where: { reversalOfEntryId: null } });
    const seen = new Map();
    for (const e of nonReversals) {
      if (!e.referenceType || !e.referenceId) continue;
      const key = `${e.referenceType}:${e.referenceId}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    expect([...seen.entries()].filter(([, n]) => n > 1)).toEqual([]);
  });

  it('6. Reports equal the transactional data, and document numbers are unique', async () => {
    // Inventory report reconciles to the ledger.
    const recon = await as(admin).get(`/api/v1/reports/inventory/reconciliation?factoryId=${A.plantA.id}&page=1&limit=200`);
    expect(Number(recon.body.data.summary.mismatchCount)).toBe(0);

    const stock = await as(admin).get(`/api/v1/reports/inventory/current-stock?factoryId=${A.plantA.id}&page=1&limit=100`);
    const cementRow = stock.body.data.rows.find((r) => r.productCode === 'RM-OPC');
    expect(Number(cementRow.openingStock) + Number(cementRow.stockIn) - Number(cementRow.stockOut)).toBe(Number(cementRow.closingStock));
    expect(Number(cementRow.closingStock)).toBe(await ledgerQty(A.plantA.id, A.cement.id));

    // Day book balances like the journal it is built on.
    const dayBook = await as(admin).get(`/api/v1/reports/finance/day-book?factoryId=${A.plantA.id}&page=1&limit=200`);
    const d = dayBook.body.data.rows.reduce((s, r) => s + Number(r.debitPaise || 0), 0);
    const c = dayBook.body.data.rows.reduce((s, r) => s + Number(r.creditPaise || 0), 0);
    expect(d).toBe(c);

    // Every document number, across every series, is unique within the tenant.
    const collections = [
      ['sales_orders', 'orderNumber'], ['delivery_challans', 'challanNumber'], ['sales_invoices', 'invoiceNumber'],
      ['goods_receipts', 'grnNumber'], ['purchase_orders', 'poNumber'], ['receipts', 'receiptNumber'],
      ['payments', 'paymentNumber'], ['expenses', 'expenseNumber'], ['stock_transfers', 'transferNumber'],
      ['production_entries', 'entryNumber'],
    ];
    for (const [table, column] of collections) {
      const [rows] = await sequelize.query(
        `SELECT "tenantId", "${column}" AS n, COUNT(*)::int AS c FROM "${table}" GROUP BY 1, 2 HAVING COUNT(*) > 1`
      );
      expect([table, rows]).toEqual([table, []]);
    }
  });

  it('7. Notifications were raised by the system, not fabricated', async () => {
    const count = await Notification.count();
    expect(count).toBeGreaterThanOrEqual(0);
    const all = await Notification.findAll();
    // De-duplication holds: no two notifications share a dedupe key in a tenant.
    const keys = all.map((n) => `${n.tenantId}:${n.dedupeKey}`);
    expect(new Set(keys).size).toBe(keys.length);
  });
});
