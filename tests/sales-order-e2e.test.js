const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party,
  SalesOrderLine, StockLedgerEntry, AuditLog,
} = require('../src/models/index');

/**
 * The complete Sales & Order Management chain, end to end, in the order the
 * business actually runs it:
 *
 *   Customer -> Sales Order -> validation -> availability -> reservation
 *   -> production requirement -> production -> finished goods
 *   -> delivery challan -> invoice -> payment -> ledger -> receivables
 *   -> reports -> audit log
 *
 * Deliberately one continuous scenario rather than isolated cases: the point
 * is that each step consumes what the previous step produced.
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

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Flow Co', slug: 'flow-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Flow Precast Pvt Ltd', code: 'FLOW' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@flow.test', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const factory = await Factory.create({
    tenantId, organizationId: org.id, name: 'Flow Plant', code: 'FP',
    state: 'Odisha', varianceThresholdPercent: 5, dispatchTolerancePercent: 0,
  });
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  ctx = { tenantId, factory, uom };
  cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@flow.test', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('Sales & Order Management — complete business flow', () => {
  let customer;
  let cement;
  let slab;
  let orderId;
  let lineId;
  let challanId;
  let invoiceId;
  let invoiceTotal;

  it('1. Customer, products and a BOM exist', async () => {
    const c = await post('/api/v1/parties', {
      partyType: 'CUSTOMER', name: 'Konark Infra', code: 'CUST-KI', gstin: '21KONAR1234K1Z5',
      state: 'Odisha', creditLimitPaise: 5000000000, creditAgeingDays: 30, creditAction: 'WARN',
    });
    expect(c.status).toBe(201);
    customer = c.body.data;
    expect((await post(`/api/v1/parties/${customer.id}/addresses`, { line1: 'Site 1', state: 'Odisha' })).status).toBe(201);

    const hsn = await post('/api/v1/hsn-codes', { code: '68109990', gstRatePercent: 18 });
    cement = (await post('/api/v1/products', { uomId: ctx.uom.id, name: 'Cement', code: 'RM-CEM', productType: 'RAW_MATERIAL', standardCostPaise: 40000 })).body.data;
    slab = (await post('/api/v1/products', {
      uomId: ctx.uom.id, hsnId: hsn.body.data.id, name: 'Precast Slab', code: 'FG-SLAB',
      productType: 'FINISHED_GOOD', curingDays: 0,
    })).body.data;

    const vendor = (await post('/api/v1/parties', { partyType: 'VENDOR', name: 'Cement Supplier' })).body.data;
    const bom = await post('/api/v1/mix-designs', {
      productId: slab.id, name: 'Slab Mix', activate: true, effectiveFrom: '2026-04-01',
      lines: [{ rawMaterialProductId: cement.id, quantityPerUnit: 2, uomId: ctx.uom.id }],
    });
    expect(bom.status).toBe(201);

    // Raw material in, finished goods deliberately NOT stocked yet.
    expect((await post('/api/v1/purchasing/receipts', {
      factoryId: ctx.factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-01',
      lines: [{ productId: cement.id, receivedQty: 1000, ratePaise: 40000 }],
    })).status).toBe(201);
  });

  it('2. Order validation and availability run at order entry', async () => {
    const atp = await get(`/api/v1/sales/atp?factoryId=${ctx.factory.id}&productId=${slab.id}`);
    expect(atp.status).toBe(200);
    expect(atp.body.data.available).toBe(0); // nothing made yet

    // Validation actually bites before anything is written.
    expect((await post('/api/v1/sales/orders', {
      factoryId: ctx.factory.id, customerPartyId: customer.id, orderDate: '2026-08-10',
      lines: [{ productId: slab.id, orderedQty: 0, ratePaise: 100000 }],
    })).status).toBe(400);

    const order = await post('/api/v1/sales/orders', {
      factoryId: ctx.factory.id, customerPartyId: customer.id,
      orderDate: '2026-08-10', expectedDeliveryDate: '2026-08-25', poReferenceNumber: 'KI/PO/77',
      lines: [{ productId: slab.id, orderedQty: 100, ratePaise: 100000 }],
    });
    expect(order.status).toBe(201);
    expect(order.body.data.status).toBe('DRAFT');
    orderId = order.body.data.id;
    lineId = order.body.data.lines[0].id;
  });

  it('3. A draft is still correctable', async () => {
    const edited = await put(`/api/v1/sales/orders/${orderId}`, {
      lines: [{ productId: slab.id, orderedQty: 120, ratePaise: 100000 }],
    });
    expect(edited.status).toBe(200);
    expect(Number(edited.body.data.lines[0].orderedQty)).toBe(120);
    lineId = edited.body.data.lines[0].id;

    // Back to 100 for the rest of the flow.
    const reverted = await put(`/api/v1/sales/orders/${orderId}`, {
      lines: [{ productId: slab.id, orderedQty: 100, ratePaise: 100000 }],
    });
    lineId = reverted.body.data.lines[0].id;
    expect(Number(reverted.body.data.totalAmountPaise)).toBe(10000000);
  });

  it('4. Confirmation reserves what exists and books the rest as production', async () => {
    const confirmed = await put(`/api/v1/sales/orders/${orderId}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('CONFIRMED');
    // No finished goods at all, so the whole order must be produced.
    expect(Number(confirmed.body.data.lines[0].productionRequired)).toBe(100);
  });

  it('5. The order is flagged as waiting on manufacture', async () => {
    const marked = await put(`/api/v1/sales/orders/${orderId}/in-production`);
    expect(marked.status).toBe(200);
    expect(marked.body.data.status).toBe('IN_PRODUCTION');
  });

  it('6. Production consumes raw material per the BOM and yields finished goods', async () => {
    const entry = await post('/api/v1/production/entries', {
      factoryId: ctx.factory.id, productId: slab.id, productionDate: '2026-08-12', goodQty: 100, rejectedQty: 0,
    });
    expect(entry.status).toBe(201);
    expect(entry.body.data.consumptions).toHaveLength(1);
    expect(Number(entry.body.data.consumptions[0].mixDesignQty)).toBe(200); // 2/unit x 100

    const atp = await get(`/api/v1/sales/atp?factoryId=${ctx.factory.id}&productId=${slab.id}`);
    expect(atp.body.data.onHand).toBe(100);
  });

  it('7. Delivery goes out in two parts and the pending balance is exact', async () => {
    const first = await post('/api/v1/dispatch/challans', {
      salesOrderId: orderId, vehicleNumber: 'OD-02-Z-9001', driverName: 'B. Nayak', dispatchDate: '2026-08-14',
      lines: [{ salesOrderLineId: lineId, dispatchedQty: 40 }],
    });
    expect(first.status).toBe(201);
    expect((await get(`/api/v1/sales/orders/${orderId}`)).body.data.status).toBe('PARTIALLY_DISPATCHED');

    const second = await post('/api/v1/dispatch/challans', {
      salesOrderId: orderId, vehicleNumber: 'OD-02-Z-9002', dispatchDate: '2026-08-15',
      lines: [{ salesOrderLineId: lineId, dispatchedQty: 30 }],
    });
    expect(second.status).toBe(201);
    challanId = second.body.data.id;

    const line = await SalesOrderLine.findByPk(lineId);
    expect(Number(line.dispatchedQty)).toBe(70);
    expect(Number(line.orderedQty) - Number(line.dispatchedQty)).toBe(30);

    // Inventory left exactly once per dispatch.
    const outs = await StockLedgerEntry.findAll({ where: { productId: slab.id, movementType: 'SALE_OUT' } });
    expect(outs.reduce((s, e) => s + Number(e.quantity), 0)).toBe(70);
    expect((await get(`/api/v1/sales/atp?factoryId=${ctx.factory.id}&productId=${slab.id}`)).body.data.onHand).toBe(30);
  });

  it('8. The dispatch is invoiced with GST from the shipping address', async () => {
    const invoice = await post('/api/v1/invoices', { challanIds: [challanId], invoiceDate: '2026-08-16' });
    expect(invoice.status).toBe(201);
    invoiceId = invoice.body.data.id;
    invoiceTotal = Number(invoice.body.data.totalPaise);

    expect(invoice.body.data.customerPartyId).toBe(customer.id);
    expect(Number(invoice.body.data.subtotalPaise)).toBe(3000000); // 30 x 1000.00
    expect(Number(invoice.body.data.cgstPaise)).toBeGreaterThan(0); // Odisha -> Odisha
    expect(Number(invoice.body.data.igstPaise)).toBe(0);
    expect(invoiceTotal % 100).toBe(0); // rounded to the rupee
  });

  it('9. Payment is received, allocated, and clears the receivable', async () => {
    const half = Math.floor(invoiceTotal / 2);
    expect((await post('/api/v1/receipts', {
      factoryId: ctx.factory.id, customerPartyId: customer.id, receiptDate: '2026-08-18',
      modes: [{ mode: 'BANK', amountPaise: half, reference: 'UTR-A' }],
      allocations: [{ invoiceId, allocatedAmountPaise: half }],
    })).status).toBe(201);

    expect((await post('/api/v1/receipts', {
      factoryId: ctx.factory.id, customerPartyId: customer.id, receiptDate: '2026-08-19',
      modes: [{ mode: 'CASH', amountPaise: invoiceTotal - half }],
      allocations: [{ invoiceId, allocatedAmountPaise: invoiceTotal - half }],
    })).status).toBe(201);

    // A third rupee has nowhere to go.
    const over = await post('/api/v1/receipts', {
      factoryId: ctx.factory.id, customerPartyId: customer.id, receiptDate: '2026-08-20',
      modes: [{ mode: 'CASH', amountPaise: 100 }],
      allocations: [{ invoiceId, allocatedAmountPaise: 100 }],
    });
    expect(over.status).toBe(400);
  });

  it('10. The customer ledger and receivables agree with the documents', async () => {
    const ledger = await get(`/api/v1/ledger/party/${customer.id}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.data.rows.length).toBeGreaterThan(0);
    expect(Number(ledger.body.data.outstandingPaise ?? 0)).toBe(0);

    const outstanding = await get(`/api/v1/reports/customer/outstanding?factoryId=${ctx.factory.id}&page=1&limit=50`);
    expect(outstanding.status).toBe(200);
  });

  it('11. The sales reports show this order and its invoice', async () => {
    for (const path of ['sales/summary', 'sales/detail', 'sales/by-customer', 'sales/by-product', 'sales/by-location', 'orders/pending', 'customer/ledger']) {
      const res = await get(`/api/v1/reports/${path}?factoryId=${ctx.factory.id}&page=1&limit=50`);
      expect([path, res.status]).toEqual([path, 200]);
    }
    const summary = await get(`/api/v1/reports/sales/summary?factoryId=${ctx.factory.id}&page=1&limit=50`);
    expect(JSON.stringify(summary.body)).toContain('Konark Infra');

    // 30 of 100 are still undelivered, so this order belongs in Pending Orders.
    const pending = await get(`/api/v1/reports/orders/pending?factoryId=${ctx.factory.id}&page=1&limit=50`);
    expect(pending.body.data.rows.length).toBeGreaterThan(0);
  });

  it('12. Short-closing the balance releases its hold and ends the order', async () => {
    const closed = await put(`/api/v1/sales/orders/${orderId}/short-close`, { reason: 'customer took delivery of 70 only' });
    expect(closed.status).toBe(200);
    expect(closed.body.data.status).toBe('SHORT_CLOSED');

    // The 30 held for this order return to the open pool.
    expect((await get(`/api/v1/sales/atp?factoryId=${ctx.factory.id}&productId=${slab.id}`)).body.data.available).toBe(30);

    // Terminal: nothing further is permitted.
    expect((await put(`/api/v1/sales/orders/${orderId}/cancel`, { reason: 'no' })).status).toBe(400);
    expect((await post('/api/v1/dispatch/challans', {
      salesOrderId: orderId, vehicleNumber: 'OD-02-Z-9003', dispatchDate: '2026-08-21',
      lines: [{ salesOrderLineId: lineId, dispatchedQty: 5 }],
    })).status).toBe(400);
  });

  it('13. Every step of the chain is on the audit log, attributed to a user', async () => {
    for (const entityType of ['SalesOrder', 'DeliveryChallan', 'SalesInvoice', 'Receipt']) {
      const rows = await AuditLog.findAll({ where: { entityType } });
      expect([entityType, rows.length > 0]).toEqual([entityType, true]);
      expect([entityType, rows.every((r) => r.userId)]).toEqual([entityType, true]);
    }

    const orderTrail = await AuditLog.findAll({ where: { entityType: 'SalesOrder', entityId: orderId } });
    const actions = orderTrail.map((r) => r.action);
    expect(actions).toContain('CREATE');
    expect(actions).toContain('UPDATE');
    // The status walk is recorded with before/after values, not just a timestamp.
    const statusChanges = orderTrail.filter((r) => r.afterSnapshot && r.afterSnapshot.status);
    expect(statusChanges.map((r) => r.afterSnapshot.status)).toEqual(
      expect.arrayContaining(['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED', 'SHORT_CLOSED'])
    );
  });
});
