const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party,
  AdGroup, AdGroupMember, UserFactory, PurchaseOrderLine, GoodsReceipt,
  PurchaseInvoice, StockLedgerEntry, JournalEntry, JournalLine, Account, AuditLog,
} = require('../src/models/index');

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
let buyer;      // PURCHASE create/modify but NOT approve
let approver;   // PURCHASE_APPROVE only
let other;

const as = (cookie) => ({
  get: (p) => request(app).get(p).set('Cookie', cookie),
  post: (p, b) => request(app).post(p).set('Cookie', cookie).send(b),
  put: (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {}),
});

const newPO = (overrides = {}, cookie = admin) =>
  as(cookie).post('/api/v1/purchasing/orders', {
    factoryId: T.plantA.id,
    vendorPartyId: T.vendor.id,
    orderDate: '2026-08-10',
    lines: [{ productId: T.cement.id, orderedQty: 100, ratePaise: 40000 }],
    ...overrides,
  });

const newGRN = (overrides = {}, cookie = admin) =>
  as(cookie).post('/api/v1/purchasing/receipts', {
    factoryId: T.plantA.id,
    vendorPartyId: T.vendor.id,
    receiptDate: '2026-08-11',
    lines: [{ productId: T.cement.id, receivedQty: 100, ratePaise: 40000 }],
    ...overrides,
  });

const newInvoice = (grnId, overrides = {}, cookie = admin) =>
  as(cookie).post('/api/v1/purchasing/invoices', {
    factoryId: T.plantA.id,
    goodsReceiptId: grnId,
    vendorPartyId: T.vendor.id,
    vendorInvoiceNumber: `VINV-${Math.abs(grnId.split('-')[0].split('').reduce((a, c) => a + c.charCodeAt(0), 0))}-${overrides.seq || 1}`,
    invoiceDate: '2026-08-12',
    amountPaise: 4000000,
    ...overrides,
  });

/** Net movement on a party's control account, credit-positive (payables). */
const vendorPayable = async (partyId) => {
  const lines = await JournalLine.findAll({ where: { partyId } });
  return lines.reduce((sum, l) => sum + Number(l.creditPaise) - Number(l.debitPaise), 0);
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Purchase Audit Co', slug: 'purchase-audit', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Purchase Audit Pvt Ltd', code: 'PAC' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  await User.create(
    { tenantId, email: 'admin@purchase-audit.test', passwordHash, firstName: 'Ada', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });

  const plantA = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant A', code: 'PA', state: 'Odisha' });
  const plantB = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant B', code: 'PB', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  const hsn = await require('../src/models/index').HsnCode.create({ tenantId, code: '2523', gstRatePercent: 28 });
  const cement = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Cement', code: 'RM-CEM', productType: 'RAW_MATERIAL' });
  const steel = await Product.create({ tenantId, uomId: uom.id, name: 'Steel', code: 'RM-STL', productType: 'RAW_MATERIAL' });
  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Odisha Cement Co', code: 'VEND-1', state: 'Odisha' });

  T = { tenantId, org, plantA, plantB, uom, cement, steel, vendor };
  admin = await loginAs('admin@purchase-audit.test');

  const mkUser = async (email, permissions, factoryId) => {
    const u = await User.create(
      { tenantId, email, passwordHash, firstName: 'X', lastName: 'Y', role: 'EMPLOYEE' },
      { validate: false }
    );
    const g = await AdGroup.create({ tenantId, name: `G ${email}`, permissions });
    await AdGroupMember.create({ tenantId, adGroupId: g.id, employeeId: u.id });
    if (factoryId) await UserFactory.create({ tenantId, userId: u.id, factoryId });
    return loginAs(email);
  };

  plantBOnly = await mkUser(
    'plantb@purchase-audit.test',
    ['PURCHASE_READ', 'PURCHASE_CREATE', 'PURCHASE_MODIFY', 'PAYMENT_READ', 'PAYMENT_CREATE', 'VIEW_RATES', 'REPORT_PURCHASE_READ', 'REPORT_VENDOR_READ'],
    plantB.id
  );
  // FR-M11-1: raising an indent and approving it are deliberately different rights.
  buyer = await mkUser('buyer@purchase-audit.test', ['PURCHASE_READ', 'PURCHASE_CREATE', 'PURCHASE_MODIFY', 'VIEW_RATES'], plantA.id);
  approver = await mkUser('approver@purchase-audit.test', ['PURCHASE_READ', 'PURCHASE_APPROVE', 'VIEW_RATES'], plantA.id);

  const t2 = await Tenant.create({ name: 'Rival Co', slug: 'rival-purchase', status: 'active' });
  const org2 = await Organization.create({ tenantId: t2.id, name: 'Rival Pvt', code: 'RIV' });
  await User.create(
    { tenantId: t2.id, email: 'admin@rival-purchase.test', passwordHash, firstName: 'R', lastName: 'R', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId: t2.id, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const rf = await Factory.create({ tenantId: t2.id, organizationId: org2.id, name: 'Rival Plant', code: 'RP', state: 'Odisha' });
  const ru = await Uom.create({ tenantId: t2.id, name: 'Numbers', code: 'NOS' });
  const rp = await Product.create({ tenantId: t2.id, uomId: ru.id, name: 'Rival Cement', code: 'RM-CEM', productType: 'RAW_MATERIAL' });
  const rv = await Party.create({ tenantId: t2.id, partyType: 'VENDOR', name: 'Rival Vendor' });
  other = { tenantId: t2.id, factory: rf, product: rp, vendor: rv, cookie: await loginAs('admin@rival-purchase.test') };
});

afterAll(async () => {
  await sequelize.close();
});

// ===========================================================================
// A. Indent -> approval -> PO
// ===========================================================================
describe('A. Indent, approval and conversion', () => {
  let indentId;

  it('raises an indent, and the raiser cannot approve their own', async () => {
    const indent = await as(buyer).post('/api/v1/purchasing/indents', {
      factoryId: T.plantA.id, indentDate: '2026-08-05', requiredByDate: '2026-08-20',
      lines: [{ productId: T.cement.id, quantity: 100 }],
    });
    expect(indent.status).toBe(201);
    indentId = indent.body.data.id;

    // FR-M11-1: approval is a separate grant from creation.
    expect((await as(buyer).put(`/api/v1/purchasing/indents/${indentId}/approve`)).status).toBe(403);
  });

  it('approves through the approver and converts to a purchase order', async () => {
    const approved = await as(approver).put(`/api/v1/purchasing/indents/${indentId}/approve`);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');

    const converted = await as(buyer).post(`/api/v1/purchasing/indents/${indentId}/convert`, {
      vendorPartyId: T.vendor.id, orderDate: '2026-08-06',
      lineRates: [{ productId: T.cement.id, ratePaise: 40000 }],
    });
    expect(converted.status).toBe(201);
    expect(converted.body.data.vendorPartyId).toBe(T.vendor.id);
  });

  it('refuses to convert the same indent twice', async () => {
    const again = await as(buyer).post(`/api/v1/purchasing/indents/${indentId}/convert`, {
      vendorPartyId: T.vendor.id, orderDate: '2026-08-06',
      lineRates: [{ productId: T.cement.id, ratePaise: 40000 }],
    });
    expect(again.status).toBe(400);
  });
});

// ===========================================================================
// B. Purchase order
// ===========================================================================
describe('B. Purchase order', () => {
  it('creates, views and cancels; refuses an invalid transition', async () => {
    const po = await newPO();
    expect(po.status).toBe(201);
    const id = po.body.data.id;

    expect((await as(admin).get(`/api/v1/purchasing/orders/${id}`)).status).toBe(200);
    expect((await as(admin).put(`/api/v1/purchasing/orders/${id}/confirm`)).status).toBe(200);
    // Confirming twice is not a legal move.
    expect((await as(admin).put(`/api/v1/purchasing/orders/${id}/confirm`)).status).toBe(400);

    expect((await as(admin).put(`/api/v1/purchasing/orders/${id}/cancel`, { reason: 'vendor withdrew' })).status).toBe(200);
    expect((await as(admin).put(`/api/v1/purchasing/orders/${id}/cancel`, { reason: 'again' })).status).toBe(400);
  });

  it('edits a DRAFT purchase order and refuses to edit a confirmed one', async () => {
    const po = await newPO();
    const id = po.body.data.id;
    expect(Number(po.body.data.totalAmountPaise)).toBe(4000000);

    const edited = await as(admin).put(`/api/v1/purchasing/orders/${id}`, {
      lines: [{ productId: T.cement.id, orderedQty: 150, ratePaise: 40000 }],
    });
    expect(edited.status).toBe(200);
    expect(Number(edited.body.data.totalAmountPaise)).toBe(6000000);

    await as(admin).put(`/api/v1/purchasing/orders/${id}/confirm`);
    const late = await as(admin).put(`/api/v1/purchasing/orders/${id}`, {
      lines: [{ productId: T.cement.id, orderedQty: 999, ratePaise: 1 }],
    });
    expect(late.status).toBe(400);
    expect(late.body.message).toMatch(/draft/i);
  });

  it('validates vendor, product, quantity and rate', async () => {
    expect((await newPO({ lines: [{ productId: T.cement.id, orderedQty: 0, ratePaise: 100 }] })).status).toBe(400);
    expect((await newPO({ lines: [{ productId: T.cement.id, orderedQty: -1, ratePaise: 100 }] })).status).toBe(400);
    expect((await newPO({ lines: [{ productId: T.cement.id, orderedQty: 1, ratePaise: -1 }] })).status).toBe(400);

    // A customer is not a vendor.
    const customer = await Party.create({ tenantId: T.tenantId, partyType: 'CUSTOMER', name: 'Not A Vendor' });
    expect((await newPO({ vendorPartyId: customer.id })).status).toBe(400);

    // The same product twice on one order is a data-entry error.
    const dupe = await newPO({
      lines: [
        { productId: T.cement.id, orderedQty: 5, ratePaise: 100 },
        { productId: T.cement.id, orderedQty: 3, ratePaise: 100 },
      ],
    });
    expect(dupe.status).toBe(400);
  });

  it('searches, sorts, filters and paginates', async () => {
    const created = await newPO();
    const num = created.body.data.poNumber;

    const search = await as(admin).get(`/api/v1/purchasing/orders?search=${encodeURIComponent(num)}&limit=100`);
    expect(search.status).toBe(200);
    expect(search.body.data.rows.every((r) => r.poNumber === num)).toBe(true);

    const byVendor = await as(admin).get('/api/v1/purchasing/orders?search=Odisha%20Cement&limit=100');
    expect(byVendor.body.data.rows.length).toBeGreaterThan(0);

    const asc = await as(admin).get('/api/v1/purchasing/orders?sortBy=poNumber&sortDir=asc&limit=100');
    const desc = await as(admin).get('/api/v1/purchasing/orders?sortBy=poNumber&sortDir=desc&limit=100');
    const a = asc.body.data.rows.map((r) => r.poNumber);
    expect(a.length).toBeGreaterThan(1);
    expect(a).toEqual([...a].sort());
    expect(desc.body.data.rows.map((r) => r.poNumber)).toEqual([...a].reverse());

    const filtered = await as(admin).get('/api/v1/purchasing/orders?status=CANCELLED&limit=100');
    expect(filtered.body.data.rows.every((r) => r.status === 'CANCELLED')).toBe(true);

    const page = await as(admin).get('/api/v1/purchasing/orders?page=1&limit=2');
    expect(page.body.data.rows).toHaveLength(2);
    expect(page.body.data.totalPages).toBeGreaterThan(1);
  });
});

// ===========================================================================
// C. Goods receipt -> inventory
// ===========================================================================
describe('C. Goods receipt and inventory IN', () => {
  it('adds stock at the receiving factory only, exactly once', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'GRN A', code: 'RM-GRN-A', productType: 'RAW_MATERIAL' });

    const grn = await newGRN({ lines: [{ productId: product.id, receivedQty: 80, ratePaise: 1000 }] });
    expect(grn.status).toBe(201);

    const atA = await as(admin).get(`/api/v1/inventory/balance?factoryId=${T.plantA.id}&productId=${product.id}`);
    expect(Number(atA.body.data.balance)).toBe(80);

    const atB = await as(admin).get(`/api/v1/inventory/balance?factoryId=${T.plantB.id}&productId=${product.id}`);
    expect(Number(atB.body.data.balance)).toBe(0);

    const ins = await StockLedgerEntry.findAll({ where: { productId: product.id, movementType: 'PURCHASE_IN' } });
    expect(ins).toHaveLength(1);
    expect(Number(ins[0].quantity)).toBe(80);
  });

  it('receives a purchase order partially, then completes it, tracking receivedQty', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'GRN B', code: 'RM-GRN-B', productType: 'RAW_MATERIAL' });
    const po = await newPO({ lines: [{ productId: product.id, orderedQty: 100, ratePaise: 1000 }] });
    await as(admin).put(`/api/v1/purchasing/orders/${po.body.data.id}/confirm`);
    const poLineId = po.body.data.lines[0].id;

    const first = await newGRN({
      purchaseOrderId: po.body.data.id,
      lines: [{ productId: product.id, receivedQty: 60, ratePaise: 1000, purchaseOrderLineId: poLineId }],
    });
    expect(first.status).toBe(201);
    expect((await as(admin).get(`/api/v1/purchasing/orders/${po.body.data.id}`)).body.data.status).toBe('PARTIALLY_RECEIVED');
    expect(Number((await PurchaseOrderLine.findByPk(poLineId)).receivedQty)).toBe(60);

    const second = await newGRN({
      purchaseOrderId: po.body.data.id,
      lines: [{ productId: product.id, receivedQty: 40, ratePaise: 1000, purchaseOrderLineId: poLineId }],
    });
    expect(second.status).toBe(201);
    expect((await as(admin).get(`/api/v1/purchasing/orders/${po.body.data.id}`)).body.data.status).toBe('RECEIVED');
    expect(Number((await PurchaseOrderLine.findByPk(poLineId)).receivedQty)).toBe(100);
  });

  it('refuses to receive more than the purchase order ordered', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'GRN C', code: 'RM-GRN-C', productType: 'RAW_MATERIAL' });
    const po = await newPO({ lines: [{ productId: product.id, orderedQty: 50, ratePaise: 1000 }] });
    await as(admin).put(`/api/v1/purchasing/orders/${po.body.data.id}/confirm`);
    const poLineId = po.body.data.lines[0].id;

    const over = await newGRN({
      purchaseOrderId: po.body.data.id,
      lines: [{ productId: product.id, receivedQty: 61, ratePaise: 1000, purchaseOrderLineId: poLineId }],
    });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/exceeds|ordered/i);
  });

  it('cancels a goods receipt, reversing the stock exactly once', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'GRN D', code: 'RM-GRN-D', productType: 'RAW_MATERIAL' });
    const grn = await newGRN({ lines: [{ productId: product.id, receivedQty: 70, ratePaise: 1000 }] });
    const grnId = grn.body.data.id;

    const cancelled = await as(admin).put(`/api/v1/purchasing/receipts/${grnId}/cancel`, { reason: 'wrong material delivered' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');

    const balance = await as(admin).get(`/api/v1/inventory/balance?factoryId=${T.plantA.id}&productId=${product.id}`);
    expect(Number(balance.body.data.balance)).toBe(0);

    const entries = await StockLedgerEntry.findAll({ where: { productId: product.id } });
    expect(entries.filter((e) => e.movementType === 'PURCHASE_IN')).toHaveLength(1);
    expect(entries.filter((e) => e.movementType === 'REVERSAL')).toHaveLength(1);

    // The record and its number survive.
    expect((await as(admin).get(`/api/v1/purchasing/receipts/${grnId}`)).body.data.grnNumber).toBe(grn.body.data.grnNumber);
    // ...and it cannot be cancelled twice.
    expect((await as(admin).put(`/api/v1/purchasing/receipts/${grnId}/cancel`, { reason: 'again' })).status).toBe(400);
  });

  it('refuses to cancel a goods receipt whose stock has already been consumed', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'GRN E', code: 'RM-GRN-E', productType: 'RAW_MATERIAL' });
    const grn = await newGRN({ lines: [{ productId: product.id, receivedQty: 10, ratePaise: 1000 }] });

    // Issue it out via a stock transfer so the lot no longer holds the quantity.
    const lotId = grn.body.data.lines[0].lotId;
    const transfer = await as(admin).post('/api/v1/transfers', {
      fromFactoryId: T.plantA.id, toFactoryId: T.plantB.id, initiatedDate: '2026-08-12',
      lines: [{ productId: product.id, sourceLotId: lotId, quantity: 10 }],
    });
    expect(transfer.status).toBe(201);

    const cancelled = await as(admin).put(`/api/v1/purchasing/receipts/${grn.body.data.id}/cancel`, { reason: 'too late' });
    expect(cancelled.status).toBe(400);
  });

  it('two concurrent receipts against one purchase order never exceed the ordered quantity', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'GRN F', code: 'RM-GRN-F', productType: 'RAW_MATERIAL' });
    const po = await newPO({ lines: [{ productId: product.id, orderedQty: 100, ratePaise: 1000 }] });
    await as(admin).put(`/api/v1/purchasing/orders/${po.body.data.id}/confirm`);
    const poLineId = po.body.data.lines[0].id;

    const fire = () =>
      newGRN({
        purchaseOrderId: po.body.data.id,
        lines: [{ productId: product.id, receivedQty: 70, ratePaise: 1000, purchaseOrderLineId: poLineId }],
      });

    const [a, b] = await Promise.all([fire(), fire()]);
    expect([a, b].filter((r) => r.status === 201).length).toBe(1);
    expect(Number((await PurchaseOrderLine.findByPk(poLineId)).receivedQty)).toBe(70);

    const ins = await StockLedgerEntry.findAll({ where: { productId: product.id, movementType: 'PURCHASE_IN' } });
    expect(ins.reduce((s, e) => s + Number(e.quantity), 0)).toBe(70);
  });
});

// ===========================================================================
// D. Purchase invoice -> vendor payable -> ledger
// ===========================================================================
describe('D. Purchase invoice and the vendor ledger', () => {
  it('raises the vendor payable in the general ledger', async () => {
    const vendor = await Party.create({ tenantId: T.tenantId, partyType: 'VENDOR', name: 'Ledger Vendor 1', state: 'Odisha' });
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'PI A', code: 'RM-PI-A', productType: 'RAW_MATERIAL' });
    const grn = await newGRN({ vendorPartyId: vendor.id, lines: [{ productId: product.id, receivedQty: 100, ratePaise: 40000 }] });

    const invoice = await newInvoice(grn.body.data.id, { vendorPartyId: vendor.id, amountPaise: 4000000 });
    expect(invoice.status).toBe(201);

    // A purchase invoice must hit the books: Dr Purchase Expense / Cr Payable.
    const entry = await JournalEntry.findOne({ where: { referenceType: 'PurchaseInvoice', referenceId: invoice.body.data.id } });
    expect(entry).not.toBeNull();

    const lines = await JournalLine.findAll({ where: { journalEntryId: entry.id }, include: [{ model: Account, as: 'account' }] });
    const debits = lines.reduce((s, l) => s + Number(l.debitPaise), 0);
    const credits = lines.reduce((s, l) => s + Number(l.creditPaise), 0);
    expect(debits).toBe(credits); // balanced
    expect(debits).toBe(4000000);

    // The vendor now shows a payable of exactly the invoice value.
    expect(await vendorPayable(vendor.id)).toBe(4000000);
  });

  it('refuses a second invoice against the same goods receipt', async () => {
    const vendor = await Party.create({ tenantId: T.tenantId, partyType: 'VENDOR', name: 'Ledger Vendor 2', state: 'Odisha' });
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'PI B', code: 'RM-PI-B', productType: 'RAW_MATERIAL' });
    const grn = await newGRN({ vendorPartyId: vendor.id, lines: [{ productId: product.id, receivedQty: 10, ratePaise: 1000 }] });

    expect((await newInvoice(grn.body.data.id, { vendorPartyId: vendor.id, amountPaise: 10000, seq: 1 })).status).toBe(201);
    const second = await newInvoice(grn.body.data.id, { vendorPartyId: vendor.id, amountPaise: 10000, seq: 2 });
    expect(second.status).toBe(409);
    expect(second.body.message).toMatch(/already/i);

    // The payable must not have doubled.
    expect(await vendorPayable(vendor.id)).toBe(10000);
  });

  it('refuses an invoice whose vendor or factory disagrees with its goods receipt', async () => {
    const vendor = await Party.create({ tenantId: T.tenantId, partyType: 'VENDOR', name: 'Ledger Vendor 3', state: 'Odisha' });
    const stranger = await Party.create({ tenantId: T.tenantId, partyType: 'VENDOR', name: 'Stranger Vendor', state: 'Odisha' });
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'PI C', code: 'RM-PI-C', productType: 'RAW_MATERIAL' });
    const grn = await newGRN({ vendorPartyId: vendor.id, lines: [{ productId: product.id, receivedQty: 10, ratePaise: 1000 }] });

    const wrongVendor = await newInvoice(grn.body.data.id, { vendorPartyId: stranger.id, amountPaise: 10000 });
    expect(wrongVendor.status).toBe(400);

    const wrongFactory = await newInvoice(grn.body.data.id, { vendorPartyId: vendor.id, factoryId: T.plantB.id, amountPaise: 10000 });
    expect(wrongFactory.status).toBe(400);
  });

  it('refuses to invoice a cancelled goods receipt', async () => {
    const vendor = await Party.create({ tenantId: T.tenantId, partyType: 'VENDOR', name: 'Ledger Vendor 4', state: 'Odisha' });
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'PI D', code: 'RM-PI-D', productType: 'RAW_MATERIAL' });
    const grn = await newGRN({ vendorPartyId: vendor.id, lines: [{ productId: product.id, receivedQty: 10, ratePaise: 1000 }] });
    await as(admin).put(`/api/v1/purchasing/receipts/${grn.body.data.id}/cancel`, { reason: 'returned at gate' });

    const invoice = await newInvoice(grn.body.data.id, { vendorPartyId: vendor.id, amountPaise: 10000 });
    expect(invoice.status).toBe(400);
  });

  it('settles by partial then full payment and closes the payable at nil', async () => {
    const vendor = await Party.create({ tenantId: T.tenantId, partyType: 'VENDOR', name: 'Paying Vendor', state: 'Odisha' });
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'PI E', code: 'RM-PI-E', productType: 'RAW_MATERIAL' });
    const grn = await newGRN({ vendorPartyId: vendor.id, lines: [{ productId: product.id, receivedQty: 100, ratePaise: 10000 }] });
    const invoice = await newInvoice(grn.body.data.id, { vendorPartyId: vendor.id, amountPaise: 1000000 });
    const invoiceId = invoice.body.data.id;

    expect(await vendorPayable(vendor.id)).toBe(1000000);

    const pay = (amount) =>
      as(admin).post('/api/v1/payments', {
        factoryId: T.plantA.id, partyId: vendor.id, paymentDate: '2026-08-15',
        modes: [{ mode: 'BANK', amountPaise: amount, reference: 'UTR' }],
        allocations: [{ invoiceId, allocatedAmountPaise: amount }],
      });

    expect((await pay(400000)).status).toBe(201);
    expect((await PurchaseInvoice.findByPk(invoiceId)).paymentStatus).toBe('PARTIALLY_PAID');
    expect(await vendorPayable(vendor.id)).toBe(600000);

    expect((await pay(600000)).status).toBe(201);
    expect((await PurchaseInvoice.findByPk(invoiceId)).paymentStatus).toBe('PAID');
    expect(await vendorPayable(vendor.id)).toBe(0);

    // Overpayment has nowhere to go.
    expect((await pay(1)).status).toBe(400);
  });

  it('cancels a purchase invoice, reversing the payable, and refuses once it is paid', async () => {
    const vendor = await Party.create({ tenantId: T.tenantId, partyType: 'VENDOR', name: 'Cancel Vendor', state: 'Odisha' });
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'PI F', code: 'RM-PI-F', productType: 'RAW_MATERIAL' });

    // Unpaid: cancels cleanly and the payable unwinds.
    const grn1 = await newGRN({ vendorPartyId: vendor.id, lines: [{ productId: product.id, receivedQty: 10, ratePaise: 1000 }] });
    const inv1 = await newInvoice(grn1.body.data.id, { vendorPartyId: vendor.id, amountPaise: 10000, seq: 1 });
    expect(await vendorPayable(vendor.id)).toBe(10000);

    const cancelled = await as(admin).put(`/api/v1/purchasing/invoices/${inv1.body.data.id}/cancel`, { reason: 'duplicate bill' });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(await vendorPayable(vendor.id)).toBe(0);

    // Paid: must be refused.
    const grn2 = await newGRN({ vendorPartyId: vendor.id, lines: [{ productId: product.id, receivedQty: 10, ratePaise: 1000 }] });
    const inv2 = await newInvoice(grn2.body.data.id, { vendorPartyId: vendor.id, amountPaise: 10000, seq: 2 });
    const paid = await as(admin).post('/api/v1/payments', {
      factoryId: T.plantA.id, partyId: vendor.id, paymentDate: '2026-08-15',
      modes: [{ mode: 'BANK', amountPaise: 10000, reference: 'UTR-CX' }],
      allocations: [{ invoiceId: inv2.body.data.id, allocatedAmountPaise: 10000 }],
    });
    expect(paid.status).toBe(201);
    const refused = await as(admin).put(`/api/v1/purchasing/invoices/${inv2.body.data.id}/cancel`, { reason: 'oops' });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/paid|payment|allocat/i);
  });

  it('does not let payment status be set by hand without money moving', async () => {
    const vendor = await Party.create({ tenantId: T.tenantId, partyType: 'VENDOR', name: 'Override Vendor', state: 'Odisha' });
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'PI G', code: 'RM-PI-G', productType: 'RAW_MATERIAL' });
    const grn = await newGRN({ vendorPartyId: vendor.id, lines: [{ productId: product.id, receivedQty: 10, ratePaise: 1000 }] });
    const invoice = await newInvoice(grn.body.data.id, { vendorPartyId: vendor.id, amountPaise: 10000 });

    // Marking an unpaid invoice PAID by hand would zero a real payable with no
    // payment behind it, and the ledger would still show the money owed.
    const forced = await as(admin).put(`/api/v1/purchasing/invoices/${invoice.body.data.id}/payment-status`, { paymentStatus: 'PAID' });
    expect([400, 404, 405]).toContain(forced.status);
    expect((await PurchaseInvoice.findByPk(invoice.body.data.id)).paymentStatus).toBe('UNPAID');
  });
});

// ===========================================================================
// E. Security
// ===========================================================================
describe('E. Security', () => {
  it('never leaks another tenant\'s purchase documents', async () => {
    const mine = await newPO();
    expect((await as(other.cookie).get(`/api/v1/purchasing/orders/${mine.body.data.id}`)).status).toBe(404);
    const listed = await as(other.cookie).get('/api/v1/purchasing/orders?limit=100');
    expect(listed.body.data.rows.some((r) => r.id === mine.body.data.id)).toBe(false);
  });

  it('confines a Plant-B user to Plant B across orders, receipts and invoices', async () => {
    const plantAOrder = await newPO({ factoryId: T.plantA.id });

    const orders = await as(plantBOnly).get('/api/v1/purchasing/orders?limit=100');
    expect(orders.status).toBe(200);
    expect(orders.body.data.rows.some((r) => r.factoryId === T.plantA.id)).toBe(false);
    expect([403, 404]).toContain((await as(plantBOnly).get(`/api/v1/purchasing/orders/${plantAOrder.body.data.id}`)).status);

    // Raising a purchase for a forbidden location is the same breach as reading one.
    expect((await newPO({ factoryId: T.plantA.id }, plantBOnly)).status).toBe(403);
    expect((await newGRN({ factoryId: T.plantA.id }, plantBOnly)).status).toBe(403);
    expect((await newPO({ factoryId: T.plantB.id }, plantBOnly)).status).toBe(201);

    const receipts = await as(plantBOnly).get('/api/v1/purchasing/receipts?limit=100');
    expect(receipts.body.data.rows.some((r) => r.factoryId === T.plantA.id)).toBe(false);
    const invoices = await as(plantBOnly).get('/api/v1/purchasing/invoices?limit=100');
    expect(invoices.body.data.rows.some((r) => r.factoryId === T.plantA.id)).toBe(false);
  });

  it('enforces RBAC on every purchase write', async () => {
    const viewer = await User.create(
      { tenantId: T.tenantId, email: 'viewer@purchase-audit.test', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'V', lastName: 'V', role: 'EMPLOYEE' },
      { validate: false }
    );
    const g = await AdGroup.create({ tenantId: T.tenantId, name: 'Purchase Viewer', permissions: ['PURCHASE_READ'] });
    await AdGroupMember.create({ tenantId: T.tenantId, adGroupId: g.id, employeeId: viewer.id });
    const cookie = await loginAs('viewer@purchase-audit.test');

    expect((await as(cookie).get('/api/v1/purchasing/orders')).status).toBe(200);
    expect((await newPO({}, cookie)).status).toBe(403);
    expect((await newGRN({}, cookie)).status).toBe(403);
    expect((await request(app).get('/api/v1/purchasing/orders')).status).toBe(401);
  });

  it('strips money from a user without VIEW_RATES', async () => {
    const clerk = await User.create(
      { tenantId: T.tenantId, email: 'clerk@purchase-audit.test', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'C', lastName: 'C', role: 'EMPLOYEE' },
      { validate: false }
    );
    const g = await AdGroup.create({ tenantId: T.tenantId, name: 'Purchase Clerk', permissions: ['PURCHASE_READ'] });
    await AdGroupMember.create({ tenantId: T.tenantId, adGroupId: g.id, employeeId: clerk.id });
    const cookie = await loginAs('clerk@purchase-audit.test');

    const listed = await as(cookie).get('/api/v1/purchasing/orders?limit=5');
    expect(listed.status).toBe(200);
    expect(listed.body.data.rows.every((r) => r.totalAmountPaise === null || r.totalAmountPaise === undefined)).toBe(true);
  });
});

// ===========================================================================
// F. Reports
// ===========================================================================
describe('F. Reports', () => {
  const REPORTS = [
    ['Purchase Summary', 'purchase/summary'],
    ['Purchase Detail', 'purchase/detail'],
    ['Vendor Purchase', 'purchase/by-vendor'],
    ['Product Purchase', 'purchase/by-product'],
    ['Payables', 'vendor/outstanding'],
    ['Vendor Ledger', 'vendor/ledger'],
    ['Inventory', 'inventory/current-stock'],
  ];

  it('serves every purchase report the flow feeds', async () => {
    for (const [label, path] of REPORTS) {
      const res = await as(admin).get(`/api/v1/reports/${path}?factoryId=${T.plantA.id}&page=1&limit=20`);
      expect([label, res.status]).toEqual([label, 200]);
    }
  });

  it('shows the vendor and its payable in the reports', async () => {
    const product = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'Rpt', code: 'RM-RPT', productType: 'RAW_MATERIAL' });
    const grn = await newGRN({ lines: [{ productId: product.id, receivedQty: 5, ratePaise: 1000 }] });
    expect((await newInvoice(grn.body.data.id, { amountPaise: 5000, seq: 9 })).status).toBe(201);

    const summary = await as(admin).get(`/api/v1/reports/purchase/summary?factoryId=${T.plantA.id}&page=1&limit=100`);
    expect(summary.status).toBe(200);
    expect(JSON.stringify(summary.body)).toContain('Odisha Cement Co');
  });

  it('confines a Plant-B user\'s purchase reports to Plant B', async () => {
    expect((await as(plantBOnly).get(`/api/v1/reports/purchase/summary?factoryId=${T.plantA.id}&page=1&limit=20`)).status).toBe(403);
    const implicit = await as(plantBOnly).get('/api/v1/reports/purchase/summary?page=1&limit=100');
    expect(implicit.status).toBe(200);
    expect(JSON.stringify(implicit.body)).not.toContain(T.plantA.id);
  });
});

// ===========================================================================
// G. Audit log
// ===========================================================================
describe('G. Audit log', () => {
  it('records the purchase chain with attribution', async () => {
    for (const entityType of ['PurchaseOrder', 'GoodsReceipt', 'PurchaseInvoice']) {
      const rows = await AuditLog.findAll({ where: { entityType } });
      expect([entityType, rows.length > 0]).toEqual([entityType, true]);
      expect([entityType, rows.every((r) => r.userId)]).toEqual([entityType, true]);
    }
  });
});
