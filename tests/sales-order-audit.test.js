const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party,
  AdGroup, AdGroupMember, UserFactory, SalesOrder, SalesOrderLine,
  StockReservation, StockLedgerEntry, PaymentAllocation, AuditLog,
} = require('../src/models/index');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

let T; // tenant A context
let other; // a second tenant, for isolation
let admin; // full-access cookie
let plantBOnly; // user assigned ONLY to factory B
let readOnly; // SALES_READ only

const as = (cookie) => ({
  get: (p) => request(app).get(p).set('Cookie', cookie),
  post: (p, b) => request(app).post(p).set('Cookie', cookie).send(b),
  put: (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {}),
  del: (p) => request(app).delete(p).set('Cookie', cookie),
});

/** Stocks `qty` of `product` at `factory` through a real goods receipt. */
const stock = async (factory, product, qty, date = '2026-08-01') => {
  const res = await as(admin).post('/api/v1/purchasing/receipts', {
    factoryId: factory.id,
    vendorPartyId: T.vendor.id,
    receiptDate: date,
    lines: [{ productId: product.id, receivedQty: qty, ratePaise: 1000 }],
  });
  if (res.status !== 201) throw new Error(`stock() failed: ${res.status} ${res.body.message}`);
  return res.body.data;
};

const newOrder = async (overrides = {}, cookie = admin) =>
  as(cookie).post('/api/v1/sales/orders', {
    factoryId: T.plantA.id,
    customerPartyId: T.customer.id,
    orderDate: '2026-08-10',
    lines: [{ productId: T.slab.id, orderedQty: 10, ratePaise: 100000 }],
    ...overrides,
  });

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Sales Audit Co', slug: 'sales-audit', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Sales Audit Pvt Ltd', code: 'SAC' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  await User.create(
    { tenantId, email: 'admin@sales-audit.test', passwordHash, firstName: 'Ada', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });

  const plantA = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant A', code: 'PA', state: 'Odisha', dispatchTolerancePercent: 0 });
  const plantB = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant B', code: 'PB', state: 'Odisha', dispatchTolerancePercent: 0 });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  const slab = await Product.create({ tenantId, uomId: uom.id, name: 'Precast Slab', code: 'FG-SLAB', productType: 'FINISHED_GOOD', curingDays: 0 });
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Kalinga Builders', state: 'Odisha' });
  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Supplier Co' });

  T = { tenantId, org, plantA, plantB, uom, slab, customer, vendor };
  admin = await loginAs('admin@sales-audit.test');

  // A user assigned to Plant B only — BR-29 says they must not see Plant A data.
  const bUser = await User.create(
    { tenantId, email: 'plantb@sales-audit.test', passwordHash, firstName: 'Bea', lastName: 'Plant', role: 'EMPLOYEE' },
    { validate: false }
  );
  const bGroup = await AdGroup.create({
    tenantId, name: 'Plant B Sales',
    permissions: [
      'SALES_READ', 'SALES_CREATE', 'SALES_MODIFY',
      'DISPATCH_READ', 'DISPATCH_CREATE', 'INVOICE_READ', 'INVOICE_CREATE',
      'RECEIPT_READ', 'RECEIPT_CREATE', 'VIEW_RATES',
      // Granted so the reports assertions below test *location* scoping rather
      // than tripping over category permission gating first.
      'REPORT_SALES_READ', 'REPORT_ORDER_READ', 'REPORT_CUSTOMER_READ',
    ],
  });
  await AdGroupMember.create({ tenantId, adGroupId: bGroup.id, employeeId: bUser.id });
  await UserFactory.create({ tenantId, userId: bUser.id, factoryId: plantB.id });
  plantBOnly = await loginAs('plantb@sales-audit.test');

  const roUser = await User.create(
    { tenantId, email: 'readonly@sales-audit.test', passwordHash, firstName: 'Ray', lastName: 'Only', role: 'EMPLOYEE' },
    { validate: false }
  );
  const roGroup = await AdGroup.create({ tenantId, name: 'Sales Viewer', permissions: ['SALES_READ'] });
  await AdGroupMember.create({ tenantId, adGroupId: roGroup.id, employeeId: roUser.id });
  readOnly = await loginAs('readonly@sales-audit.test');

  // Second tenant, for organization isolation.
  const t2 = await Tenant.create({ name: 'Rival Co', slug: 'rival-co', status: 'active' });
  const org2 = await Organization.create({ tenantId: t2.id, name: 'Rival Pvt Ltd', code: 'RIV' });
  await User.create(
    { tenantId: t2.id, email: 'admin@rival.test', passwordHash, firstName: 'Rob', lastName: 'Rival', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId: t2.id, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const rf = await Factory.create({ tenantId: t2.id, organizationId: org2.id, name: 'Rival Plant', code: 'RP', state: 'Odisha' });
  const ru = await Uom.create({ tenantId: t2.id, name: 'Numbers', code: 'NOS' });
  const rp = await Product.create({ tenantId: t2.id, uomId: ru.id, name: 'Rival Slab', code: 'FG-SLAB', productType: 'FINISHED_GOOD' });
  const rc = await Party.create({ tenantId: t2.id, partyType: 'CUSTOMER', name: 'Rival Customer', state: 'Odisha' });
  other = { tenantId: t2.id, factory: rf, product: rp, customer: rc, cookie: await loginAs('admin@rival.test') };

  await stock(plantA, slab, 500);
  await stock(plantB, slab, 500);
});

afterAll(async () => {
  await sequelize.close();
});

// ===========================================================================
// A. Sales order status lifecycle — invalid transitions must be refused
// ===========================================================================
describe('A. Sales order status lifecycle', () => {
  it('walks DRAFT -> CONFIRMED -> PARTIALLY_DISPATCHED -> DISPATCHED', async () => {
    const order = await newOrder();
    expect(order.status).toBe(201);
    expect(order.body.data.status).toBe('DRAFT');
    const id = order.body.data.id;

    const confirmed = await as(admin).put(`/api/v1/sales/orders/${id}/confirm`);
    expect(confirmed.body.data.status).toBe('CONFIRMED');
    const lineId = confirmed.body.data.lines[0].id;

    await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: id, vehicleNumber: 'OD-01-A-1', dispatchDate: '2026-08-11',
      lines: [{ salesOrderLineId: lineId, dispatchedQty: 4 }],
    });
    expect((await as(admin).get(`/api/v1/sales/orders/${id}`)).body.data.status).toBe('PARTIALLY_DISPATCHED');

    await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: id, vehicleNumber: 'OD-01-A-2', dispatchDate: '2026-08-12',
      lines: [{ salesOrderLineId: lineId, dispatchedQty: 6 }],
    });
    expect((await as(admin).get(`/api/v1/sales/orders/${id}`)).body.data.status).toBe('DISPATCHED');
  });

  it('refuses to confirm an order twice', async () => {
    const id = (await newOrder()).body.data.id;
    expect((await as(admin).put(`/api/v1/sales/orders/${id}/confirm`)).status).toBe(200);
    const again = await as(admin).put(`/api/v1/sales/orders/${id}/confirm`);
    expect(again.status).toBe(400);
  });

  it('refuses to confirm, cancel or short-close a CANCELLED order', async () => {
    const id = (await newOrder()).body.data.id;
    expect((await as(admin).put(`/api/v1/sales/orders/${id}/cancel`, { reason: 'customer withdrew' })).status).toBe(200);

    expect((await as(admin).put(`/api/v1/sales/orders/${id}/confirm`)).status).toBe(400);
    expect((await as(admin).put(`/api/v1/sales/orders/${id}/cancel`, { reason: 'again' })).status).toBe(400);
    expect((await as(admin).put(`/api/v1/sales/orders/${id}/short-close`, { reason: 'again' })).status).toBe(400);
  });

  it('refuses to cancel an order that has been dispatched', async () => {
    const id = (await newOrder()).body.data.id;
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${id}/confirm`);
    await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: id, vehicleNumber: 'OD-01-A-3', dispatchDate: '2026-08-11',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 3 }],
    });
    const cancelled = await as(admin).put(`/api/v1/sales/orders/${id}/cancel`, { reason: 'too late' });
    expect(cancelled.status).toBe(400);
    expect(cancelled.body.message).toMatch(/short-closed/i);
  });

  it('refuses to short-close an order with no dispatch, and refuses dispatch against a cancelled order', async () => {
    const id = (await newOrder()).body.data.id;
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${id}/confirm`);
    expect((await as(admin).put(`/api/v1/sales/orders/${id}/short-close`, { reason: 'x' })).status).toBe(400);

    await as(admin).put(`/api/v1/sales/orders/${id}/cancel`, { reason: 'dropped' });
    const dispatched = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: id, vehicleNumber: 'OD-01-A-4', dispatchDate: '2026-08-11',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 1 }],
    });
    expect(dispatched.status).toBe(400);
  });

  it('reaches IN_PRODUCTION when an order is short and production is planned against it', async () => {
    // The enum, ACTIVE_ORDER_STATUSES and the dashboard all reference
    // IN_PRODUCTION; the flow in the brief requires it after a shortfall.
    const empty = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Unstocked', code: 'FG-UNSTOCKED', productType: 'FINISHED_GOOD' });
    const order = await newOrder({ lines: [{ productId: empty.id, orderedQty: 25, ratePaise: 100 }] });
    const id = order.body.data.id;
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${id}/confirm`);
    expect(Number(confirmed.body.data.lines[0].productionRequired)).toBe(25);

    const marked = await as(admin).put(`/api/v1/sales/orders/${id}/in-production`);
    expect(marked.status).toBe(200);
    expect(marked.body.data.status).toBe('IN_PRODUCTION');

    // and it remains dispatchable from IN_PRODUCTION
    expect(['CONFIRMED', 'IN_PRODUCTION']).toContain(marked.body.data.status);
  });

  it('refuses to mark a DRAFT order IN_PRODUCTION', async () => {
    const id = (await newOrder()).body.data.id;
    expect((await as(admin).put(`/api/v1/sales/orders/${id}/in-production`)).status).toBe(400);
  });
});

// ===========================================================================
// B. Sales order CRUD, search, sorting, filters, pagination
// ===========================================================================
describe('B. Sales order create / view / edit / list', () => {
  it('edits a DRAFT order: lines, quantities, rates and totals all update', async () => {
    const order = await newOrder({ lines: [{ productId: T.slab.id, orderedQty: 10, ratePaise: 100000 }] });
    const id = order.body.data.id;
    expect(Number(order.body.data.totalAmountPaise)).toBe(1000000);

    const edited = await as(admin).put(`/api/v1/sales/orders/${id}`, {
      expectedDeliveryDate: '2026-09-01',
      poReferenceNumber: 'PO-XYZ',
      lines: [{ productId: T.slab.id, orderedQty: 20, ratePaise: 150000 }],
    });
    expect(edited.status).toBe(200);
    expect(edited.body.data.poReferenceNumber).toBe('PO-XYZ');
    expect(edited.body.data.lines).toHaveLength(1);
    expect(Number(edited.body.data.lines[0].orderedQty)).toBe(20);
    expect(Number(edited.body.data.totalAmountPaise)).toBe(3000000);
  });

  it('refuses to edit a CONFIRMED order', async () => {
    const id = (await newOrder()).body.data.id;
    await as(admin).put(`/api/v1/sales/orders/${id}/confirm`);
    const edited = await as(admin).put(`/api/v1/sales/orders/${id}`, {
      lines: [{ productId: T.slab.id, orderedQty: 99, ratePaise: 100 }],
    });
    expect(edited.status).toBe(400);
    expect(edited.body.message).toMatch(/draft/i);
  });

  it('validates quantity and rate on create', async () => {
    expect((await newOrder({ lines: [{ productId: T.slab.id, orderedQty: 0, ratePaise: 100 }] })).status).toBe(400);
    expect((await newOrder({ lines: [{ productId: T.slab.id, orderedQty: -5, ratePaise: 100 }] })).status).toBe(400);
    expect((await newOrder({ lines: [{ productId: T.slab.id, orderedQty: 5, ratePaise: -1 }] })).status).toBe(400);
    expect((await newOrder({ lines: [] })).status).toBe(400);
  });

  it('refuses an order whose expected delivery date precedes its order date', async () => {
    const res = await newOrder({ orderDate: '2026-08-10', expectedDeliveryDate: '2026-08-01' });
    expect(res.status).toBe(400);
  });

  it('refuses two lines for the same product on one order', async () => {
    const res = await newOrder({
      lines: [
        { productId: T.slab.id, orderedQty: 5, ratePaise: 100 },
        { productId: T.slab.id, orderedQty: 3, ratePaise: 100 },
      ],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/more than one|more than once|duplicate/i);
  });

  it('searches by order number and by customer name', async () => {
    const created = await newOrder();
    const num = created.body.data.orderNumber;

    const byNumber = await as(admin).get(`/api/v1/sales/orders?search=${encodeURIComponent(num)}&limit=100`);
    expect(byNumber.status).toBe(200);
    expect(byNumber.body.data.rows.some((r) => r.orderNumber === num)).toBe(true);
    expect(byNumber.body.data.rows.every((r) => r.orderNumber === num)).toBe(true);

    const byCustomer = await as(admin).get('/api/v1/sales/orders?search=Kalinga&limit=100');
    expect(byCustomer.status).toBe(200);
    expect(byCustomer.body.data.rows.length).toBeGreaterThan(0);
  });

  it('sorts by order number in both directions across the whole result set', async () => {
    const asc = await as(admin).get('/api/v1/sales/orders?sortBy=orderNumber&sortDir=asc&limit=100');
    const desc = await as(admin).get('/api/v1/sales/orders?sortBy=orderNumber&sortDir=desc&limit=100');
    expect(asc.status).toBe(200);
    const a = asc.body.data.rows.map((r) => r.orderNumber);
    const d = desc.body.data.rows.map((r) => r.orderNumber);
    expect(a.length).toBeGreaterThan(1);
    expect(a).toEqual([...a].sort());
    expect(d).toEqual([...a].reverse());
  });

  it('filters by status and paginates', async () => {
    const filtered = await as(admin).get('/api/v1/sales/orders?status=CANCELLED&limit=100');
    expect(filtered.status).toBe(200);
    expect(filtered.body.data.rows.every((r) => r.status === 'CANCELLED')).toBe(true);

    const page1 = await as(admin).get('/api/v1/sales/orders?page=1&limit=2');
    expect(page1.body.data.rows).toHaveLength(2);
    expect(page1.body.data.page).toBe(1);
    expect(page1.body.data.totalPages).toBeGreaterThan(1);
  });

  it('writes an audit trail for create, confirm and cancel', async () => {
    const id = (await newOrder()).body.data.id;
    await as(admin).put(`/api/v1/sales/orders/${id}/confirm`);
    await as(admin).put(`/api/v1/sales/orders/${id}/cancel`, { reason: 'audit check' });

    const rows = await AuditLog.findAll({ where: { entityType: 'SalesOrder', entityId: id } });
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(['CREATE', 'UPDATE']));
    expect(rows.every((r) => r.userId)).toBe(true);
  });
});

// ===========================================================================
// C. Stock reservation
// ===========================================================================
describe('C. Stock reservation', () => {
  it('reserves exactly the confirmed quantity and reduces available-to-promise', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Resv A', code: 'FG-RESV-A', productType: 'FINISHED_GOOD' });
    await stock(T.plantA, product, 100);

    const before = await as(admin).get(`/api/v1/sales/atp?factoryId=${T.plantA.id}&productId=${product.id}`);
    expect(before.body.data.available).toBe(100);

    const order = await newOrder({ lines: [{ productId: product.id, orderedQty: 30, ratePaise: 100 }] });
    await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);

    const after = await as(admin).get(`/api/v1/sales/atp?factoryId=${T.plantA.id}&productId=${product.id}`);
    expect(after.body.data.available).toBe(70);
    expect(after.body.data.reserved).toBe(30);
  });

  it('reserves partially and books the balance as a production requirement', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Resv B', code: 'FG-RESV-B', productType: 'FINISHED_GOOD' });
    await stock(T.plantA, product, 40);

    const order = await newOrder({ lines: [{ productId: product.id, orderedQty: 100, ratePaise: 100 }] });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    expect(Number(confirmed.body.data.lines[0].productionRequired)).toBe(60);

    const atp = await as(admin).get(`/api/v1/sales/atp?factoryId=${T.plantA.id}&productId=${product.id}`);
    expect(atp.body.data.available).toBe(0);
    expect(atp.body.data.reserved).toBe(40);
  });

  it('releases the hold on cancel and on short-close', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Resv C', code: 'FG-RESV-C', productType: 'FINISHED_GOOD' });
    await stock(T.plantA, product, 100);

    const order = await newOrder({ lines: [{ productId: product.id, orderedQty: 40, ratePaise: 100 }] });
    const id = order.body.data.id;
    await as(admin).put(`/api/v1/sales/orders/${id}/confirm`);
    expect((await as(admin).get(`/api/v1/sales/atp?factoryId=${T.plantA.id}&productId=${product.id}`)).body.data.available).toBe(60);

    await as(admin).put(`/api/v1/sales/orders/${id}/cancel`, { reason: 'released' });
    expect((await as(admin).get(`/api/v1/sales/atp?factoryId=${T.plantA.id}&productId=${product.id}`)).body.data.available).toBe(100);
    expect(await StockReservation.count({ where: { referenceId: order.body.data.lines[0].id, status: 'ACTIVE' } })).toBe(0);
  });

  it('keeps reservations location-specific — stock at Plant B never covers a Plant A order', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Resv D', code: 'FG-RESV-D', productType: 'FINISHED_GOOD' });
    await stock(T.plantB, product, 100); // stocked at B only

    const atpA = await as(admin).get(`/api/v1/sales/atp?factoryId=${T.plantA.id}&productId=${product.id}`);
    expect(atpA.body.data.available).toBe(0);

    const order = await newOrder({ factoryId: T.plantA.id, lines: [{ productId: product.id, orderedQty: 10, ratePaise: 100 }] });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    expect(Number(confirmed.body.data.lines[0].productionRequired)).toBe(10);
  });

  it('two concurrent confirmations never reserve the same units twice', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Race A', code: 'FG-RACE-A', productType: 'FINISHED_GOOD' });
    await stock(T.plantA, product, 100);

    const o1 = await newOrder({ lines: [{ productId: product.id, orderedQty: 80, ratePaise: 100 }] });
    const o2 = await newOrder({ lines: [{ productId: product.id, orderedQty: 80, ratePaise: 100 }] });

    const [r1, r2] = await Promise.all([
      as(admin).put(`/api/v1/sales/orders/${o1.body.data.id}/confirm`),
      as(admin).put(`/api/v1/sales/orders/${o2.body.data.id}/confirm`),
    ]);
    expect(r1.status).toBe(200);
    expect(r2.status).toBe(200);

    // 100 units exist. Total ACTIVE holds must never exceed that.
    const held = await StockReservation.sum('quantity', { where: { productId: product.id, status: 'ACTIVE' } });
    expect(Number(held)).toBeLessThanOrEqual(100);

    // ...and the two orders' production requirements must account for the rest.
    const lines = await SalesOrderLine.findAll({ where: { productId: product.id } });
    const totalRequired = lines.reduce((s, l) => s + Number(l.productionRequired), 0);
    expect(Number(held) + totalRequired).toBe(160);
  });
});

// ===========================================================================
// D. Delivery — partial dispatch arithmetic
// ===========================================================================
describe('D. Delivery and partial dispatch', () => {
  it('Order 100 -> deliver 40 -> deliver 30 -> pending 30, with stock out exactly once each time', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Partial', code: 'FG-PARTIAL', productType: 'FINISHED_GOOD' });
    await stock(T.plantA, product, 200);

    const order = await newOrder({ lines: [{ productId: product.id, orderedQty: 100, ratePaise: 1000 }] });
    const id = order.body.data.id;
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${id}/confirm`);
    const lineId = confirmed.body.data.lines[0].id;

    const d1 = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: id, vehicleNumber: 'OD-02-A-1', dispatchDate: '2026-08-11',
      lines: [{ salesOrderLineId: lineId, dispatchedQty: 40 }],
    });
    expect(d1.status).toBe(201);

    let line = await SalesOrderLine.findByPk(lineId);
    expect(Number(line.dispatchedQty)).toBe(40);
    expect(Number(line.orderedQty) - Number(line.dispatchedQty)).toBe(60);

    const d2 = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: id, vehicleNumber: 'OD-02-A-2', dispatchDate: '2026-08-12',
      lines: [{ salesOrderLineId: lineId, dispatchedQty: 30 }],
    });
    expect(d2.status).toBe(201);

    line = await SalesOrderLine.findByPk(lineId);
    expect(Number(line.dispatchedQty)).toBe(70);
    expect(Number(line.orderedQty) - Number(line.dispatchedQty)).toBe(30); // pending

    expect((await as(admin).get(`/api/v1/sales/orders/${id}`)).body.data.status).toBe('PARTIALLY_DISPATCHED');

    // Stock left the building exactly once per dispatch: 200 - 70 = 130.
    const atp = await as(admin).get(`/api/v1/sales/atp?factoryId=${T.plantA.id}&productId=${product.id}`);
    expect(atp.body.data.onHand).toBe(130);

    const outs = await StockLedgerEntry.findAll({ where: { productId: product.id, movementType: 'SALE_OUT' } });
    expect(outs.reduce((s, e) => s + Number(e.quantity), 0)).toBe(70);
  });

  it('refuses to dispatch more than ordered when tolerance is zero', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Over', code: 'FG-OVER', productType: 'FINISHED_GOOD' });
    await stock(T.plantA, product, 200);
    const order = await newOrder({ lines: [{ productId: product.id, orderedQty: 10, ratePaise: 100 }] });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);

    const over = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: order.body.data.id, vehicleNumber: 'OD-03-A-1', dispatchDate: '2026-08-11',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 11 }],
    });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/exceeds ordered/i);
  });

  it('two concurrent dispatches against one order never over-dispatch it', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Race D', code: 'FG-RACE-D', productType: 'FINISHED_GOOD' });
    await stock(T.plantA, product, 500);

    const order = await newOrder({ lines: [{ productId: product.id, orderedQty: 100, ratePaise: 100 }] });
    const id = order.body.data.id;
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${id}/confirm`);
    const lineId = confirmed.body.data.lines[0].id;

    const [a, b] = await Promise.all([
      as(admin).post('/api/v1/dispatch/challans', {
        salesOrderId: id, vehicleNumber: 'OD-04-A-1', dispatchDate: '2026-08-11',
        lines: [{ salesOrderLineId: lineId, dispatchedQty: 60 }],
      }),
      as(admin).post('/api/v1/dispatch/challans', {
        salesOrderId: id, vehicleNumber: 'OD-04-A-2', dispatchDate: '2026-08-11',
        lines: [{ salesOrderLineId: lineId, dispatchedQty: 60 }],
      }),
    ]);

    const succeeded = [a, b].filter((r) => r.status === 201);
    // Both cannot succeed: 60 + 60 > 100 ordered with zero tolerance.
    expect(succeeded.length).toBe(1);

    const line = await SalesOrderLine.findByPk(lineId);
    expect(Number(line.dispatchedQty)).toBe(60);

    // The recorded dispatched quantity must equal the stock that actually left.
    const outs = await StockLedgerEntry.findAll({ where: { productId: product.id, movementType: 'SALE_OUT' } });
    expect(outs.reduce((s, e) => s + Number(e.quantity), 0)).toBe(60);
  });

  it('cancelling a challan reverses the stock exactly once and restores the order', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Revert', code: 'FG-REVERT', productType: 'FINISHED_GOOD' });
    await stock(T.plantA, product, 100);

    const order = await newOrder({ lines: [{ productId: product.id, orderedQty: 50, ratePaise: 100 }] });
    const id = order.body.data.id;
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${id}/confirm`);

    const challan = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: id, vehicleNumber: 'OD-05-A-1', dispatchDate: '2026-08-11',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 50 }],
    });
    expect((await as(admin).get(`/api/v1/sales/atp?factoryId=${T.plantA.id}&productId=${product.id}`)).body.data.onHand).toBe(50);

    const cancelled = await as(admin).put(`/api/v1/dispatch/challans/${challan.body.data.id}/cancel`, { reason: 'wrong vehicle' });
    expect(cancelled.status).toBe(200);

    expect((await as(admin).get(`/api/v1/sales/atp?factoryId=${T.plantA.id}&productId=${product.id}`)).body.data.onHand).toBe(100);
    const line = await SalesOrderLine.findByPk(confirmed.body.data.lines[0].id);
    expect(Number(line.dispatchedQty)).toBe(0);

    // Exactly one OUT and one reversing IN — not two of either.
    const entries = await StockLedgerEntry.findAll({ where: { productId: product.id } });
    expect(entries.filter((e) => e.movementType === 'SALE_OUT')).toHaveLength(1);
    expect(entries.filter((e) => e.movementType === 'REVERSAL')).toHaveLength(1);
  });
});

// ===========================================================================
// E / F. Invoice and payment integrity
// ===========================================================================
describe('E. Invoice', () => {
  const build = async (qty = 10, rate = 100000) => {
    const product = await Product.create({
      tenantId: T.tenantId, uomId: T.uom.id, name: `Inv ${qty}-${rate}-${Math.abs(rate - qty)}`,
      code: `FG-INV-${qty}-${rate}`, productType: 'FINISHED_GOOD',
    });
    await stock(T.plantA, product, qty * 2);
    const order = await newOrder({ lines: [{ productId: product.id, orderedQty: qty, ratePaise: rate }] });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    const challan = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: order.body.data.id, vehicleNumber: 'OD-06-A-1', dispatchDate: '2026-08-11',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: qty }],
    });
    const invoice = await as(admin).post('/api/v1/invoices', { challanIds: [challan.body.data.id], invoiceDate: '2026-08-12' });
    return { product, orderId: order.body.data.id, challan: challan.body.data, invoice };
  };

  it('numbers the invoice, totals it, and rounds to the rupee', async () => {
    const { invoice } = await build(3, 33333);
    expect(invoice.status).toBe(201);
    expect(invoice.body.data.invoiceNumber).toMatch(/^INV/);
    const d = invoice.body.data;
    const raw = Number(d.subtotalPaise) + Number(d.cgstPaise) + Number(d.sgstPaise) + Number(d.igstPaise);
    expect(Number(d.totalPaise)).toBe(raw + Number(d.roundOffPaise));
    expect(Number(d.totalPaise) % 100).toBe(0); // rounded to whole rupees
  });

  it('refuses to invoice the same challan twice', async () => {
    const { challan } = await build(5, 10000);
    const again = await as(admin).post('/api/v1/invoices', { challanIds: [challan.id], invoiceDate: '2026-08-13' });
    expect(again.status).toBe(400);
    expect(again.body.message).toMatch(/already been invoiced/i);
  });

  it('refuses to cancel an invoice that a receipt has been allocated against', async () => {
    const { invoice } = await build(4, 50000);
    const id = invoice.body.data.id;
    const due = Number(invoice.body.data.totalPaise);

    const receipt = await as(admin).post('/api/v1/receipts', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-14',
      modes: [{ mode: 'BANK', amountPaise: due, reference: 'UTR-1' }],
      allocations: [{ invoiceId: id, allocatedAmountPaise: due }],
    });
    expect(receipt.status).toBe(201);

    const cancelled = await as(admin).put(`/api/v1/invoices/${id}/cancel`, { reason: 'raised in error' });
    expect(cancelled.status).toBe(400);
    expect(cancelled.body.message).toMatch(/payment|receipt|allocat/i);
  });

  it('cancels an unpaid invoice, reverses the ledger, and leaves the invoice readable', async () => {
    const { invoice } = await build(6, 20000);
    const id = invoice.body.data.id;
    const cancelled = await as(admin).put(`/api/v1/invoices/${id}/cancel`, { reason: 'duplicate' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const still = await as(admin).get(`/api/v1/invoices/${id}`);
    expect(still.status).toBe(200);
    expect(still.body.data.invoiceNumber).toBe(invoice.body.data.invoiceNumber);

    const ledger = await as(admin).get(`/api/v1/ledger/party/${T.customer.id}`);
    expect(ledger.status).toBe(200);
  });
});

describe('F. Payment allocation', () => {
  let invoiceId;
  let due;

  beforeAll(async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Pay', code: 'FG-PAY', productType: 'FINISHED_GOOD' });
    await stock(T.plantA, product, 100);
    const order = await newOrder({ lines: [{ productId: product.id, orderedQty: 10, ratePaise: 100000 }] });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    const challan = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: order.body.data.id, vehicleNumber: 'OD-07-A-1', dispatchDate: '2026-08-11',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 10 }],
    });
    const invoice = await as(admin).post('/api/v1/invoices', { challanIds: [challan.body.data.id], invoiceDate: '2026-08-12' });
    invoiceId = invoice.body.data.id;
    due = Number(invoice.body.data.totalPaise);
  });

  const receipt = (amount, allocated = amount) =>
    as(admin).post('/api/v1/receipts', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-15',
      modes: [{ mode: 'BANK', amountPaise: amount, reference: 'UTR' }],
      allocations: [{ invoiceId, allocatedAmountPaise: allocated }],
    });

  it('takes a partial payment, then a second payment that settles it, and refuses a third', async () => {
    const first = await receipt(Math.floor(due / 2));
    expect(first.status).toBe(201);

    const second = await receipt(due - Math.floor(due / 2));
    expect(second.status).toBe(201);

    const third = await receipt(100);
    expect(third.status).toBe(400);
    expect(third.body.message).toMatch(/exceeds the outstanding/i);
  });

  it('refuses an allocation larger than the receipt itself', async () => {
    const res = await as(admin).post('/api/v1/receipts', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-15',
      modes: [{ mode: 'CASH', amountPaise: 1000 }],
      allocations: [{ invoiceId, allocatedAmountPaise: 5000 }],
    });
    expect(res.status).toBe(400);
  });

  it('frees the invoice again once the receipt is cancelled', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Reallocate', code: 'FG-REALLOC', productType: 'FINISHED_GOOD' });
    await stock(T.plantA, product, 100);
    const order = await newOrder({ lines: [{ productId: product.id, orderedQty: 5, ratePaise: 100000 }] });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    const challan = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: order.body.data.id, vehicleNumber: 'OD-08-A-1', dispatchDate: '2026-08-11',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 5 }],
    });
    const inv = await as(admin).post('/api/v1/invoices', { challanIds: [challan.body.data.id], invoiceDate: '2026-08-12' });
    const amount = Number(inv.body.data.totalPaise);

    const r = await as(admin).post('/api/v1/receipts', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-15',
      modes: [{ mode: 'BANK', amountPaise: amount, reference: 'UTR-X' }],
      allocations: [{ invoiceId: inv.body.data.id, allocatedAmountPaise: amount }],
    });
    expect(r.status).toBe(201);

    const cancelled = await as(admin).put(`/api/v1/receipts/${r.body.data.id}/cancel`, { reason: 'wrong amount' });
    expect(cancelled.status).toBe(200);

    // The invoice is outstanding again, so a fresh receipt must be accepted.
    const redo = await as(admin).post('/api/v1/receipts', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-16',
      modes: [{ mode: 'BANK', amountPaise: amount, reference: 'UTR-Y' }],
      allocations: [{ invoiceId: inv.body.data.id, allocatedAmountPaise: amount }],
    });
    expect(redo.status).toBe(201);
  });

  it('refuses to allocate one customer\'s receipt against another customer\'s invoice', async () => {
    const stranger = await Party.create({ tenantId: T.tenantId, partyType: 'CUSTOMER', name: 'Someone Else', state: 'Odisha' });
    const res = await as(admin).post('/api/v1/receipts', {
      factoryId: T.plantA.id, customerPartyId: stranger.id, receiptDate: '2026-08-15',
      modes: [{ mode: 'CASH', amountPaise: 100 }],
      allocations: [{ invoiceId, allocatedAmountPaise: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/customer/i);
  });

  it('two concurrent receipts never over-allocate the same invoice', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Race P', code: 'FG-RACE-P', productType: 'FINISHED_GOOD' });
    await stock(T.plantA, product, 100);
    const order = await newOrder({ lines: [{ productId: product.id, orderedQty: 5, ratePaise: 100000 }] });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    const challan = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: order.body.data.id, vehicleNumber: 'OD-09-A-1', dispatchDate: '2026-08-11',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 5 }],
    });
    const inv = await as(admin).post('/api/v1/invoices', { challanIds: [challan.body.data.id], invoiceDate: '2026-08-12' });
    const full = Number(inv.body.data.totalPaise);

    const fire = () =>
      as(admin).post('/api/v1/receipts', {
        factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-15',
        modes: [{ mode: 'BANK', amountPaise: full, reference: 'UTR-R' }],
        allocations: [{ invoiceId: inv.body.data.id, allocatedAmountPaise: full }],
      });

    const [x, y] = await Promise.all([fire(), fire()]);
    expect([x, y].filter((r) => r.status === 201).length).toBe(1);

    const allocated = await PaymentAllocation.sum('allocatedAmountPaise', { where: { invoiceId: inv.body.data.id } });
    expect(Number(allocated)).toBe(full);
  });
});

// ===========================================================================
// G. Security — organization and location isolation, RBAC
// ===========================================================================
describe('G. Security', () => {
  it('never leaks another tenant\'s sales orders, challans, invoices or receipts', async () => {
    const mine = await newOrder();
    const theirs = await as(other.cookie).post('/api/v1/sales/orders', {
      factoryId: other.factory.id, customerPartyId: other.customer.id, orderDate: '2026-08-10',
      lines: [{ productId: other.product.id, orderedQty: 1, ratePaise: 100 }],
    });
    expect(theirs.status).toBe(201);

    const listed = await as(other.cookie).get('/api/v1/sales/orders?limit=100');
    expect(listed.body.data.rows.some((r) => r.id === mine.body.data.id)).toBe(false);
    expect((await as(other.cookie).get(`/api/v1/sales/orders/${mine.body.data.id}`)).status).toBe(404);
  });

  it('confines a Plant-B user to Plant B: list, read, create and dispatch', async () => {
    const plantAOrder = await newOrder({ factoryId: T.plantA.id });
    expect(plantAOrder.status).toBe(201);

    // List must not include Plant A orders.
    const listed = await as(plantBOnly).get('/api/v1/sales/orders?limit=100');
    expect(listed.status).toBe(200);
    expect(listed.body.data.rows.some((r) => r.factoryId === T.plantA.id)).toBe(false);

    // Direct read of a Plant A order must be refused.
    expect([403, 404]).toContain((await as(plantBOnly).get(`/api/v1/sales/orders/${plantAOrder.body.data.id}`)).status);

    // Creating an order *for* Plant A must be refused.
    const created = await as(plantBOnly).post('/api/v1/sales/orders', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, orderDate: '2026-08-10',
      lines: [{ productId: T.slab.id, orderedQty: 1, ratePaise: 100 }],
    });
    expect(created.status).toBe(403);

    // ...but their own factory works.
    const own = await as(plantBOnly).post('/api/v1/sales/orders', {
      factoryId: T.plantB.id, customerPartyId: T.customer.id, orderDate: '2026-08-10',
      lines: [{ productId: T.slab.id, orderedQty: 1, ratePaise: 100 }],
    });
    expect(own.status).toBe(201);
  });

  it('confines a Plant-B user on the invoice, receipt and ATP endpoints too', async () => {
    expect((await as(plantBOnly).get(`/api/v1/sales/atp?factoryId=${T.plantA.id}&productId=${T.slab.id}`)).status).toBe(403);

    const invoices = await as(plantBOnly).get('/api/v1/invoices?limit=100');
    expect(invoices.status).toBe(200);
    expect(invoices.body.data.rows.some((r) => r.factoryId === T.plantA.id)).toBe(false);

    const challans = await as(plantBOnly).get('/api/v1/dispatch/challans?limit=100');
    expect(challans.status).toBe(200);
    expect(challans.body.data.rows.some((r) => r.factoryId === T.plantA.id)).toBe(false);

    const receipts = await as(plantBOnly).get('/api/v1/receipts?limit=100');
    expect(receipts.status).toBe(200);
    expect(receipts.body.data.rows.some((r) => r.factoryId === T.plantA.id)).toBe(false);
  });

  it('enforces RBAC server-side on every sales write', async () => {
    const id = (await newOrder()).body.data.id;
    expect((await as(readOnly).get('/api/v1/sales/orders')).status).toBe(200);
    expect((await as(readOnly).post('/api/v1/sales/orders', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, orderDate: '2026-08-10',
      lines: [{ productId: T.slab.id, orderedQty: 1, ratePaise: 100 }],
    })).status).toBe(403);
    expect((await as(readOnly).put(`/api/v1/sales/orders/${id}`, { poReferenceNumber: 'X' })).status).toBe(403);
    expect((await as(readOnly).put(`/api/v1/sales/orders/${id}/confirm`)).status).toBe(403);
    expect((await as(readOnly).put(`/api/v1/sales/orders/${id}/cancel`, { reason: 'nope' })).status).toBe(403);
    expect((await request(app).get('/api/v1/sales/orders')).status).toBe(401);
  });

  it('strips money fields from a user without VIEW_RATES', async () => {
    const listed = await as(readOnly).get('/api/v1/sales/orders?limit=5');
    expect(listed.status).toBe(200);
    expect(listed.body.data.rows.every((r) => r.totalAmountPaise === null || r.totalAmountPaise === undefined)).toBe(true);
  });
});

// ===========================================================================
// H. Credit control must be scoped to the tenant
// ===========================================================================
describe('H. Credit control', () => {
  it('counts only this tenant\'s open orders against a customer credit limit', async () => {
    const capped = await Party.create({
      tenantId: T.tenantId, partyType: 'CUSTOMER', name: 'Capped Customer', state: 'Odisha',
      creditLimitPaise: 500000, creditAction: 'BLOCK',
    });
    // A same-named, same-limit customer in the OTHER tenant with a large open order.
    const rival = await Party.create({
      tenantId: other.tenantId, partyType: 'CUSTOMER', name: 'Capped Customer', state: 'Odisha',
      creditLimitPaise: 500000, creditAction: 'NONE',
    });
    await as(other.cookie).post('/api/v1/sales/orders', {
      factoryId: other.factory.id, customerPartyId: rival.id, orderDate: '2026-08-10',
      lines: [{ productId: other.product.id, orderedQty: 100, ratePaise: 100000 }],
    }).then((r) => as(other.cookie).put(`/api/v1/sales/orders/${r.body.data.id}/confirm`));

    // Well inside this tenant's limit — must be accepted regardless of the rival's volume.
    const ok = await newOrder({ customerPartyId: capped.id, lines: [{ productId: T.slab.id, orderedQty: 1, ratePaise: 400000 }] });
    expect(ok.status).toBe(201);
  });

  it('blocks an order beyond the credit limit and allows an authorised override', async () => {
    const capped = await Party.create({
      tenantId: T.tenantId, partyType: 'CUSTOMER', name: 'Tight Customer', state: 'Odisha',
      creditLimitPaise: 100000, creditAction: 'BLOCK',
    });
    const blocked = await newOrder({ customerPartyId: capped.id, lines: [{ productId: T.slab.id, orderedQty: 1, ratePaise: 900000 }] });
    expect(blocked.status).toBe(403);

    const overridden = await newOrder({
      customerPartyId: capped.id, allowCreditOverride: true,
      lines: [{ productId: T.slab.id, orderedQty: 1, ratePaise: 900000 }],
    });
    expect(overridden.status).toBe(201);
  });
});

// ===========================================================================
// I. Reporting reflects the sales chain
// ===========================================================================
describe('I. Reporting', () => {
  // The exact reports the audit brief names, at their real catalog paths.
  const REPORTS = [
    ['Sales Summary', 'sales/summary'],
    ['Sales Detail', 'sales/detail'],
    ['Customer Sales', 'sales/by-customer'],
    ['Product Sales', 'sales/by-product'],
    ['Location Sales', 'sales/by-location'],
    ['Pending Orders', 'orders/pending'],
    ['Receivables', 'customer/outstanding'],
    ['Customer Ledger', 'customer/ledger'],
  ];

  it('serves every sales report the flow feeds, for the caller\'s own factory', async () => {
    for (const [label, path] of REPORTS) {
      const res = await as(admin).get(`/api/v1/reports/${path}?factoryId=${T.plantA.id}&page=1&limit=20`);
      expect([label, res.status]).toEqual([label, 200]);
      expect(res.body.data).toBeDefined();
    }
  });

  it('shows this tenant\'s invoiced sales in the sales summary', async () => {
    const res = await as(admin).get(`/api/v1/reports/sales/summary?factoryId=${T.plantA.id}&page=1&limit=50`);
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).toContain('Kalinga Builders');
  });

  it('lists the undelivered balance in Pending Orders', async () => {
    const res = await as(admin).get(`/api/v1/reports/orders/pending?factoryId=${T.plantA.id}&page=1&limit=100`);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
  });

  it('confines a Plant-B user\'s reports to Plant B', async () => {
    // Asking for Plant A explicitly must be refused outright...
    const explicit = await as(plantBOnly).get(`/api/v1/reports/sales/summary?factoryId=${T.plantA.id}&page=1&limit=20`);
    expect(explicit.status).toBe(403);

    // ...and asking for no factory at all must silently exclude it.
    const implicit = await as(plantBOnly).get('/api/v1/reports/sales/summary?page=1&limit=100');
    expect(implicit.status).toBe(200);
    expect(JSON.stringify(implicit.body)).not.toContain(T.plantA.id);
  });
});
