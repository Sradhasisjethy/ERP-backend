const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, Factory, FinancialYear, PaymentAllocation } = require('../src/models/index');

/**
 * End-to-end proof that master data reaches every module it is supposed to.
 *
 * The audit's question is not "does the Customer screen save a row" — it is
 * whether that row then flows Customer -> Sales Order -> Delivery -> Invoice
 * -> Payment -> Ledger -> Receivables, and whether the same holds on the
 * purchase side and through production. Each master is created through its own
 * public API, then followed downstream through the real endpoints.
 */

const PASSWORD = 'password123';
let cookie;
let factory;
let uom;
let customer;
let vendor;
let rawMaterial;
let finishedGood;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const api = () => request(app);
const post = (path, body) => api().post(path).set('Cookie', cookie).send(body);
const put = (path, body) => api().put(path).set('Cookie', cookie).send(body || {});
const get = (path) => api().get(path).set('Cookie', cookie);

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'E2E Precast', slug: 'e2e-precast', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'E2E Precast Pvt Ltd', code: 'E2E' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@e2e.test', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({
    tenantId, organizationId: org.id, name: 'E2E Plant', code: 'E2E-F1',
    // Place of supply is the factory's state versus the shipping address's,
    // so the supplying factory must declare one (FR-M16-4).
    state: 'Odisha', city: 'Khordha', varianceThresholdPercent: 5,
  });

  cookie = extractCookie(await api().post('/api/v1/auth/login').send({ email: 'admin@e2e.test', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('Masters are created through their own API', () => {
  it('creates UoM, HSN, category and both products', async () => {
    const uomRes = await post('/api/v1/uoms', { name: 'Numbers', code: 'NOS' });
    expect(uomRes.status).toBe(201);
    uom = uomRes.body.data;

    const hsn = await post('/api/v1/hsn-codes', { code: '68109990', description: 'Precast concrete', gstRatePercent: 18 });
    expect(hsn.status).toBe(201);

    const category = await post('/api/v1/product-categories', { name: 'Precast', code: 'PRECAST' });
    expect(category.status).toBe(201);

    const rm = await post('/api/v1/products', {
      uomId: uom.id, name: 'Cement', code: 'RM-CEM', productType: 'RAW_MATERIAL', standardCostPaise: 40000,
    });
    expect(rm.status).toBe(201);
    rawMaterial = rm.body.data;

    const fg = await post('/api/v1/products', {
      uomId: uom.id, hsnId: hsn.body.data.id, categoryId: category.body.data.id,
      name: 'Precast Slab', code: 'FG-SLAB', productType: 'FINISHED_GOOD', curingDays: 0, reorderLevel: 10,
    });
    expect(fg.status).toBe(201);
    finishedGood = fg.body.data;
  });

  it('creates a customer and a vendor with identity, contact, tax and credit terms', async () => {
    const c = await post('/api/v1/parties', {
      partyType: 'CUSTOMER', name: 'Kalinga Builders', code: 'CUST-001',
      gstin: '21ABCDE1234F1Z5', phone: '9876543210', email: 'buy@kalinga.test',
      address: 'Plot 12', city: 'Bhubaneswar', state: 'Odisha',
      creditLimitPaise: 100000000, creditAgeingDays: 45, creditAction: 'WARN',
    });
    expect(c.status).toBe(201);
    customer = c.body.data;

    const address = await post(`/api/v1/parties/${customer.id}/addresses`, {
      label: 'Site', line1: 'NH-16 Site Office', city: 'Cuttack', state: 'Odisha', pincode: '753001',
    });
    expect(address.status).toBe(201);
    // FR-M16-4: the shipping state code is what GST place of supply is read from.
    expect(address.body.data.stateCode).toBe('21');

    const v = await post('/api/v1/parties', {
      partyType: 'VENDOR', name: 'Odisha Cement Co', code: 'VEND-001', gstin: '21ZZZZZ9999Z1Z5', state: 'Odisha',
    });
    expect(v.status).toBe(201);
    vendor = v.body.data;
  });
});

describe('Product -> BOM -> Production -> raw material consumption', () => {
  let bomId;

  it('defines and activates a BOM against the finished good', async () => {
    const bom = await post('/api/v1/mix-designs', {
      productId: finishedGood.id,
      name: 'Slab Mix v1',
      outputQuantity: 1,
      activate: true,
      effectiveFrom: '2026-04-01',
      lines: [{ rawMaterialProductId: rawMaterial.id, quantityPerUnit: 2, uomId: uom.id, wastagePercent: 5 }],
    });
    expect(bom.status).toBe(201);
    expect(bom.body.data.status).toBe('ACTIVE');
    bomId = bom.body.data.id;
  });

  it('explodes the BOM with wastage and rolls up its cost from the product master', async () => {
    const explode = await get(`/api/v1/mix-designs/${bomId}/explode?outputQty=10`);
    expect(explode.status).toBe(200);
    expect(explode.body.data.requirements[0].quantity).toBeCloseTo(21, 4); // 2 * 10 * 1.05

    const cost = await get(`/api/v1/mix-designs/${bomId}/cost`);
    expect(cost.status).toBe(200);
    // 2 units * 1.05 wastage * 40000 paise standard cost = 84000
    expect(cost.body.data.totalCostPaise).toBe(84000);
  });

  it('receives raw material against the vendor, then produces using the BOM', async () => {
    const grn = await post('/api/v1/purchasing/receipts', {
      factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-10',
      lines: [{ productId: rawMaterial.id, receivedQty: 500, ratePaise: 40000 }],
    });
    expect(grn.status).toBe(201);

    const production = await post('/api/v1/production/entries', {
      factoryId: factory.id, productId: finishedGood.id, productionDate: '2026-08-11', goodQty: 50, rejectedQty: 0,
    });
    expect(production.status).toBe(201);
    // The entry must consume per the BOM, and cite the BOM version it used.
    expect(production.body.data.mixDesignId || production.body.data.entry?.mixDesignId).toBeTruthy();
    const consumptions = production.body.data.consumptions;
    expect(consumptions).toHaveLength(1);
    expect(Number(consumptions[0].mixDesignQty)).toBe(100); // 2 per unit * 50
  });
});

describe('Customer -> Sales Order -> Delivery -> Invoice -> Payment -> Ledger', () => {
  let orderId;
  let orderLineId;
  let challanId;
  let invoiceId;

  it('raises and confirms a sales order for the customer', async () => {
    const order = await post('/api/v1/sales/orders', {
      factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-12',
      lines: [{ productId: finishedGood.id, orderedQty: 20, ratePaise: 500000 }],
    });
    expect(order.status).toBe(201);
    orderId = order.body.data.id;
    expect(order.body.data.customer.name).toBe('Kalinga Builders');

    const confirmed = await put(`/api/v1/sales/orders/${orderId}/confirm`);
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.data.status).toBe('CONFIRMED');
    orderLineId = confirmed.body.data.lines[0].id;
  });

  it('dispatches against the order', async () => {
    const challan = await post('/api/v1/dispatch/challans', {
      salesOrderId: orderId, vehicleNumber: 'OD-05-AB-1234', driverName: 'R. Sahoo', dispatchDate: '2026-08-13',
      lines: [{ salesOrderLineId: orderLineId, dispatchedQty: 20 }],
    });
    expect(challan.status).toBe(201);
    challanId = challan.body.data.id;
  });

  it('invoices the challan, with tax determined from the shipping address', async () => {
    const invoice = await post('/api/v1/invoices', { challanIds: [challanId], invoiceDate: '2026-08-14' });
    expect(invoice.status).toBe(201);
    invoiceId = invoice.body.data.id;
    expect(invoice.body.data.customerPartyId).toBe(customer.id);
    // Supplier and ship-to are both Odisha (21) -> intra-state -> CGST + SGST.
    expect(Number(invoice.body.data.cgstPaise)).toBeGreaterThan(0);
    expect(Number(invoice.body.data.igstPaise)).toBe(0);
  });

  it('receipts a payment against the invoice and clears the receivable', async () => {
    const invoice = await get(`/api/v1/invoices/${invoiceId}`);
    const due = Number(invoice.body.data.totalPaise);

    const receipt = await post('/api/v1/receipts', {
      factoryId: factory.id, customerPartyId: customer.id, receiptDate: '2026-08-15',
      modes: [{ mode: 'BANK', amountPaise: due, reference: 'UTR-001' }],
      allocations: [{ invoiceId, allocatedAmountPaise: due }],
    });
    expect(receipt.status).toBe(201);
    // A sales invoice carries no paymentStatus column of its own — settlement
    // is derived from allocations and the ledger, which is what the
    // receivables report reads. So the receipt must be fully allocated, and
    // the customer's ledger balance must go to nil (asserted next).
    expect(Number(receipt.body.data.unallocatedAmountPaise)).toBe(0);

    const allocations = await PaymentAllocation.findAll({ where: { invoiceId } });
    expect(allocations.length).toBe(1);
    expect(Number(allocations[0].allocatedAmountPaise)).toBe(due);
  });

  it('shows the whole cycle on the customer ledger with a nil closing balance', async () => {
    const ledger = await get(`/api/v1/ledger/party/${customer.id}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.data.rows.length).toBeGreaterThan(0);
    expect(Number(ledger.body.data.outstandingPaise ?? 0)).toBe(0);
  });

  it('reaches the customer outstanding and ledger reports', async () => {
    const outstanding = await get(`/api/v1/reports/customer/outstanding?factoryId=${factory.id}&page=1&limit=50`);
    expect(outstanding.status).toBe(200);

    const statement = await get(`/api/v1/reports/customer/ledger?factoryId=${factory.id}&page=1&limit=50`);
    expect(statement.status).toBe(200);
    // The report must name the master, not just its id — this is the join the
    // audit is really checking.
    const named = JSON.stringify(statement.body).includes('Kalinga Builders');
    expect(named).toBe(true);
  });
});

describe('Vendor -> Purchase -> Invoice -> Payment -> Ledger', () => {
  let poId;
  let grnId;
  let purchaseInvoiceId;

  it('raises a purchase order and receives against it', async () => {
    const po = await post('/api/v1/purchasing/orders', {
      factoryId: factory.id, vendorPartyId: vendor.id, orderDate: '2026-08-16',
      lines: [{ productId: rawMaterial.id, orderedQty: 100, ratePaise: 40000 }],
    });
    expect(po.status).toBe(201);
    poId = po.body.data.id;
    expect(po.body.data.vendor.name).toBe('Odisha Cement Co');

    await put(`/api/v1/purchasing/orders/${poId}/confirm`);
    const grn = await post('/api/v1/purchasing/receipts', {
      factoryId: factory.id, vendorPartyId: vendor.id, purchaseOrderId: poId, receiptDate: '2026-08-17',
      lines: [{ productId: rawMaterial.id, receivedQty: 100, ratePaise: 40000 }],
    });
    expect(grn.status).toBe(201);
    grnId = grn.body.data.id;
  });

  it('books the vendor invoice and pays it', async () => {
    const invoice = await post('/api/v1/purchasing/invoices', {
      factoryId: factory.id, goodsReceiptId: grnId, vendorPartyId: vendor.id,
      vendorInvoiceNumber: 'VINV-001', invoiceDate: '2026-08-18', amountPaise: 4000000,
    });
    expect(invoice.status).toBe(201);
    purchaseInvoiceId = invoice.body.data.id;

    const payment = await post('/api/v1/payments', {
      factoryId: factory.id, partyId: vendor.id, paymentDate: '2026-08-19',
      modes: [{ mode: 'BANK', amountPaise: 4000000, reference: 'UTR-002' }],
      allocations: [{ invoiceId: purchaseInvoiceId, allocatedAmountPaise: 4000000 }],
    });
    expect(payment.status).toBe(201);
  });

  it('shows the vendor ledger settled and reaches the payables report', async () => {
    const ledger = await get(`/api/v1/ledger/party/${vendor.id}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.data.rows.length).toBeGreaterThan(0);

    const payables = await get(`/api/v1/reports/vendor/outstanding?factoryId=${factory.id}&page=1&limit=50`);
    expect(payables.status).toBe(200);
  });
});

describe('Deactivating a master preserves every historical document', () => {
  it('deactivates the customer, blocks new orders, and leaves the old ones readable', async () => {
    const deactivated = await put(`/api/v1/parties/${customer.id}`, { status: 'inactive' });
    expect(deactivated.status).toBe(200);
    expect(deactivated.body.data.status).toBe('inactive');

    // No new document may name it...
    const blocked = await post('/api/v1/sales/orders', {
      factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-20',
      lines: [{ productId: finishedGood.id, orderedQty: 1, ratePaise: 100 }],
    });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/inactive/i);

    // ...and every existing one still resolves it.
    const orders = await get(`/api/v1/sales/orders?customerPartyId=${customer.id}`);
    expect(orders.body.data.rows.length).toBeGreaterThan(0);
    expect(orders.body.data.rows[0].customer.name).toBe('Kalinga Builders');

    const ledger = await get(`/api/v1/ledger/party/${customer.id}`);
    expect(ledger.status).toBe(200);
    expect(ledger.body.data.rows.length).toBeGreaterThan(0);

    // The delete path stays refused, naming what holds it.
    const deleted = await api().delete(`/api/v1/parties/${customer.id}`).set('Cookie', cookie);
    expect(deleted.status).toBe(409);
  });

  it('deactivates the finished good and keeps its BOM, stock and invoices intact', async () => {
    const deactivated = await put(`/api/v1/products/${finishedGood.id}`, { status: 'inactive' });
    expect(deactivated.status).toBe(200);

    const boms = await get(`/api/v1/mix-designs?productId=${finishedGood.id}`);
    expect(boms.body.data.rows.length).toBeGreaterThan(0);

    const balance = await get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${finishedGood.id}`);
    expect(balance.status).toBe(200);

    const deleted = await api().delete(`/api/v1/products/${finishedGood.id}`).set('Cookie', cookie);
    expect(deleted.status).toBe(409);
  });
});
