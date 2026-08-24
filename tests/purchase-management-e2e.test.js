const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, HsnCode, Product, Party,
  PurchaseOrderLine, PurchaseInvoice, StockLedgerEntry, JournalEntry, JournalLine, AuditLog,
} = require('../src/models/index');

/**
 * The complete purchase chain, end to end, in the order the business runs it:
 *
 *   Vendor -> Purchase Order -> approval -> Goods Receipt -> Inventory IN
 *   -> Purchase Invoice -> Vendor Payable -> Payment -> Vendor Ledger
 *   -> Reports -> Audit Log
 *
 * One continuous scenario: each step consumes what the last one produced.
 */

const PASSWORD = 'password123';
let cookie;
let ctx;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const get = (p) => request(app).get(p).set('Cookie', cookie);
const post = (p, b) => request(app).post(p).set('Cookie', cookie).send(b);
const put = (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {});

/** Payable balance for a party from the general ledger, credit-positive. */
const payable = async (partyId) => {
  const lines = await JournalLine.findAll({ where: { partyId } });
  return lines.reduce((s, l) => s + Number(l.creditPaise) - Number(l.debitPaise), 0);
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Purchase Flow Co', slug: 'purchase-flow', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Purchase Flow Pvt Ltd', code: 'PFC' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@pflow.test', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Flow Plant', code: 'FP', state: 'Odisha' });
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  ctx = { tenantId, factory, uom };
  cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@pflow.test', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('Purchase Management — complete business flow', () => {
  let vendor;
  let cement;
  let poId;
  let poLineId;
  let grn1;
  let grn2;
  let invoiceId;

  it('1. Vendor and product masters exist', async () => {
    const hsn = await HsnCode.create({ tenantId: ctx.tenantId, code: '2523', gstRatePercent: 28 });
    const v = await post('/api/v1/parties', {
      partyType: 'VENDOR', name: 'Odisha Cement Co', code: 'VEND-OCC',
      gstin: '21OCCPL1234C1Z5', state: 'Odisha',
    });
    expect(v.status).toBe(201);
    vendor = v.body.data;

    const p = await post('/api/v1/products', {
      uomId: ctx.uom.id, hsnId: hsn.id, name: 'OPC Cement', code: 'RM-OPC', productType: 'RAW_MATERIAL', standardCostPaise: 40000,
    });
    expect(p.status).toBe(201);
    cement = p.body.data;
  });

  it('2. An indent is raised, approved, and converted into a purchase order', async () => {
    const indent = await post('/api/v1/purchasing/indents', {
      factoryId: ctx.factory.id, indentDate: '2026-08-01', requiredByDate: '2026-08-20',
      lines: [{ productId: cement.id, quantity: 100 }],
    });
    expect(indent.status).toBe(201);
    expect(indent.body.data.status).toBe('PENDING_APPROVAL');

    const approved = await put(`/api/v1/purchasing/indents/${indent.body.data.id}/approve`);
    expect(approved.body.data.status).toBe('APPROVED');

    const po = await post(`/api/v1/purchasing/indents/${indent.body.data.id}/convert`, {
      vendorPartyId: vendor.id, orderDate: '2026-08-02',
      lineRates: [{ productId: cement.id, ratePaise: 40000 }],
    });
    expect(po.status).toBe(201);
    poId = po.body.data.id;
    poLineId = po.body.data.lines[0].id;
    expect(Number(po.body.data.totalAmountPaise)).toBe(4000000);
  });

  it('3. The draft order is corrected, then confirmed', async () => {
    const edited = await put(`/api/v1/purchasing/orders/${poId}`, {
      lines: [{ productId: cement.id, orderedQty: 120, ratePaise: 40000 }],
    });
    expect(edited.status).toBe(200);
    expect(Number(edited.body.data.totalAmountPaise)).toBe(4800000);
    poLineId = edited.body.data.lines[0].id;

    const confirmed = await put(`/api/v1/purchasing/orders/${poId}/confirm`);
    expect(confirmed.body.data.status).toBe('CONFIRMED');
    // Confirmed orders are no longer editable.
    expect((await put(`/api/v1/purchasing/orders/${poId}`, { lines: [{ productId: cement.id, orderedQty: 1, ratePaise: 1 }] })).status).toBe(400);
  });

  it('4. Goods arrive in two parts and stock goes in exactly once each time', async () => {
    grn1 = await post('/api/v1/purchasing/receipts', {
      factoryId: ctx.factory.id, vendorPartyId: vendor.id, purchaseOrderId: poId, receiptDate: '2026-08-05',
      lines: [{ productId: cement.id, receivedQty: 70, ratePaise: 40000, purchaseOrderLineId: poLineId }],
    });
    expect(grn1.status).toBe(201);
    expect((await get(`/api/v1/purchasing/orders/${poId}`)).body.data.status).toBe('PARTIALLY_RECEIVED');
    expect(Number((await get(`/api/v1/inventory/balance?factoryId=${ctx.factory.id}&productId=${cement.id}`)).body.data.balance)).toBe(70);

    grn2 = await post('/api/v1/purchasing/receipts', {
      factoryId: ctx.factory.id, vendorPartyId: vendor.id, purchaseOrderId: poId, receiptDate: '2026-08-08',
      lines: [{ productId: cement.id, receivedQty: 50, ratePaise: 40000, purchaseOrderLineId: poLineId }],
    });
    expect(grn2.status).toBe(201);
    expect((await get(`/api/v1/purchasing/orders/${poId}`)).body.data.status).toBe('RECEIVED');
    expect(Number((await PurchaseOrderLine.findByPk(poLineId)).receivedQty)).toBe(120);

    const balance = Number((await get(`/api/v1/inventory/balance?factoryId=${ctx.factory.id}&productId=${cement.id}`)).body.data.balance);
    expect(balance).toBe(120);

    const ins = await StockLedgerEntry.findAll({ where: { productId: cement.id, movementType: 'PURCHASE_IN' } });
    expect(ins).toHaveLength(2);
    expect(ins.reduce((s, e) => s + Number(e.quantity), 0)).toBe(120);

    // The order is fully received; nothing more may be taken against it.
    const over = await post('/api/v1/purchasing/receipts', {
      factoryId: ctx.factory.id, vendorPartyId: vendor.id, purchaseOrderId: poId, receiptDate: '2026-08-09',
      lines: [{ productId: cement.id, receivedQty: 30, ratePaise: 40000, purchaseOrderLineId: poLineId }],
    });
    expect(over.status).toBe(400);
  });

  it('5. A mistaken receipt can be reversed, and the stock goes back out once', async () => {
    const spare = await post('/api/v1/products', {
      uomId: ctx.uom.id, name: 'Wrong Item', code: 'RM-WRONG', productType: 'RAW_MATERIAL',
    });
    const bad = await post('/api/v1/purchasing/receipts', {
      factoryId: ctx.factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-09',
      lines: [{ productId: spare.body.data.id, receivedQty: 25, ratePaise: 100 }],
    });
    expect(bad.status).toBe(201);

    const reversed = await put(`/api/v1/purchasing/receipts/${bad.body.data.id}/cancel`, { reason: 'wrong material delivered' });
    expect(reversed.status).toBe(200);
    expect(reversed.body.data.status).toBe('CANCELLED');
    expect(Number((await get(`/api/v1/inventory/balance?factoryId=${ctx.factory.id}&productId=${spare.body.data.id}`)).body.data.balance)).toBe(0);

    const entries = await StockLedgerEntry.findAll({ where: { productId: spare.body.data.id } });
    expect(entries.filter((e) => e.movementType === 'PURCHASE_IN')).toHaveLength(1);
    expect(entries.filter((e) => e.movementType === 'REVERSAL')).toHaveLength(1);
  });

  it('6. The vendor bill books a payable in the general ledger', async () => {
    expect(await payable(vendor.id)).toBe(0);

    const invoice = await post('/api/v1/purchasing/invoices', {
      factoryId: ctx.factory.id, goodsReceiptId: grn1.body.data.id, vendorPartyId: vendor.id,
      vendorInvoiceNumber: 'OCC/2026/0441', invoiceDate: '2026-08-10', dueDate: '2026-09-09',
      amountPaise: 2800000,
    });
    expect(invoice.status).toBe(201);
    invoiceId = invoice.body.data.id;

    const entry = await JournalEntry.findOne({ where: { referenceType: 'PurchaseInvoice', referenceId: invoiceId } });
    expect(entry).not.toBeNull();
    const lines = await JournalLine.findAll({ where: { journalEntryId: entry.id } });
    expect(lines.reduce((s, l) => s + Number(l.debitPaise), 0)).toBe(2800000);
    expect(lines.reduce((s, l) => s + Number(l.creditPaise), 0)).toBe(2800000);

    expect(await payable(vendor.id)).toBe(2800000);

    // The same receipt cannot be billed twice.
    const dupe = await post('/api/v1/purchasing/invoices', {
      factoryId: ctx.factory.id, goodsReceiptId: grn1.body.data.id, vendorPartyId: vendor.id,
      vendorInvoiceNumber: 'OCC/2026/0441-B', invoiceDate: '2026-08-10', amountPaise: 2800000,
    });
    expect(dupe.status).toBe(409);
    expect(await payable(vendor.id)).toBe(2800000);
  });

  it('7. Payment settles the payable in parts and closes it at nil', async () => {
    const pay = (amount, ref) =>
      post('/api/v1/payments', {
        factoryId: ctx.factory.id, partyId: vendor.id, paymentDate: '2026-08-15',
        modes: [{ mode: 'BANK', amountPaise: amount, reference: ref }],
        allocations: [{ invoiceId, allocatedAmountPaise: amount }],
      });

    expect((await pay(1000000, 'UTR-1')).status).toBe(201);
    expect((await PurchaseInvoice.findByPk(invoiceId)).paymentStatus).toBe('PARTIALLY_PAID');
    expect(await payable(vendor.id)).toBe(1800000);

    expect((await pay(1800000, 'UTR-2')).status).toBe(201);
    expect((await PurchaseInvoice.findByPk(invoiceId)).paymentStatus).toBe('PAID');
    expect(await payable(vendor.id)).toBe(0);

    // Overpayment is refused.
    expect((await pay(1, 'UTR-3')).status).toBe(400);
    // ...and a settled bill can no longer be cancelled.
    expect((await put(`/api/v1/purchasing/invoices/${invoiceId}/cancel`, { reason: 'no' })).status).toBe(400);
  });

  it('8. A wrong bill can be cancelled while unpaid, unwinding its payable', async () => {
    const wrong = await post('/api/v1/purchasing/invoices', {
      factoryId: ctx.factory.id, goodsReceiptId: grn2.body.data.id, vendorPartyId: vendor.id,
      vendorInvoiceNumber: 'OCC/2026/0442', invoiceDate: '2026-08-11', amountPaise: 9999999,
    });
    expect(wrong.status).toBe(201);
    expect(await payable(vendor.id)).toBe(9999999);

    const cancelled = await put(`/api/v1/purchasing/invoices/${wrong.body.data.id}/cancel`, { reason: 'amount keyed wrong' });
    expect(cancelled.status).toBe(200);
    expect(await payable(vendor.id)).toBe(0);

    // The receipt is free to be billed correctly.
    const correct = await post('/api/v1/purchasing/invoices', {
      factoryId: ctx.factory.id, goodsReceiptId: grn2.body.data.id, vendorPartyId: vendor.id,
      vendorInvoiceNumber: 'OCC/2026/0443', invoiceDate: '2026-08-11', amountPaise: 2000000,
    });
    expect(correct.status).toBe(201);
    expect(await payable(vendor.id)).toBe(2000000);
  });

  it('9. The vendor ledger reflects the whole cycle', async () => {
    const ledger = await get(`/api/v1/ledger/party/${vendor.id}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.data.rows.length).toBeGreaterThan(0);
    // One bill paid in full, one still open at 20,00,000 paise.
    //
    // Magnitude, not sign: this endpoint returns debit − credit for every party
    // type, so a payable comes back negative here while the payables report
    // returns it positive. That inconsistency is a reported finding, not
    // something this test should bake in either way.
    expect(Math.abs(Number(ledger.body.data.outstandingPaise ?? 0))).toBe(2000000);
  });

  it('10. Every purchase report shows the flow, and excludes the cancelled bill', async () => {
    for (const path of ['purchase/summary', 'purchase/detail', 'purchase/by-vendor', 'purchase/by-product', 'vendor/outstanding', 'vendor/ledger', 'inventory/current-stock']) {
      const res = await get(`/api/v1/reports/${path}?factoryId=${ctx.factory.id}&page=1&limit=50`);
      expect([path, res.status]).toEqual([path, 200]);
    }

    const summary = await get(`/api/v1/reports/purchase/summary?factoryId=${ctx.factory.id}&page=1&limit=50`);
    const body = JSON.stringify(summary.body);
    expect(body).toContain('Odisha Cement Co');
    expect(body).toContain('OCC/2026/0441');
    // The cancelled bill is not a payable and must not appear.
    expect(body).not.toContain('OCC/2026/0442');
    expect(Number(summary.body.data.summary.outstandingPaise)).toBe(2000000);

    const payables = await get(`/api/v1/reports/vendor/outstanding?factoryId=${ctx.factory.id}&page=1&limit=50`);
    expect(JSON.stringify(payables.body)).not.toContain('OCC/2026/0442');

    const stock = await get(`/api/v1/reports/inventory/current-stock?factoryId=${ctx.factory.id}&page=1&limit=50`);
    expect(JSON.stringify(stock.body)).toContain('OPC Cement');
  });

  it('11. Every step is on the audit log, attributed to a user', async () => {
    for (const entityType of ['PurchaseIndent', 'PurchaseOrder', 'GoodsReceipt', 'PurchaseInvoice', 'Payment']) {
      const rows = await AuditLog.findAll({ where: { entityType } });
      expect([entityType, rows.length > 0]).toEqual([entityType, true]);
      expect([entityType, rows.every((r) => r.userId)]).toEqual([entityType, true]);
    }

    // The reversal of the wrong bill is recorded with its before/after values.
    const invoiceTrail = await AuditLog.findAll({ where: { entityType: 'PurchaseInvoice', action: 'UPDATE' } });
    const cancels = invoiceTrail.filter((r) => r.afterSnapshot && r.afterSnapshot.status === 'CANCELLED');
    expect(cancels.length).toBeGreaterThan(0);
  });
});
