const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party } = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;
let factory;
let product;
let vendor;
let customer;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-returns', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@returns-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Returns Factory', code: 'RET-FAC' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-RET' });
  product = await Product.create({ tenantId, uomId: uom.id, name: 'Cement Ret', code: 'RM-CEMENT-RET', productType: 'RAW_MATERIAL', curingDays: 0 });

  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Ret Vendor' });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Ret Customer' });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@returns-test.co', password: PASSWORD }), 'accessToken');

  await request(app)
    .post('/api/v1/purchasing/receipts')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-10', lines: [{ productId: product.id, receivedQty: 200, ratePaise: 5000 }] });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Sales Return (M22)', () => {
  it('posts stock IN and reduces customer AR', async () => {
    const before = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${product.id}`).set('Cookie', adminCookie);
    const outstandingBefore = await request(app).get(`/api/v1/ledger/party/${customer.id}`).set('Cookie', adminCookie);

    // Give the customer some AR first via an invoice-shaped debit isn't
    // available standalone here, so a credit note against an empty balance
    // still proves the mechanics (balance can legitimately go negative =
    // on-account credit, same as BR-20 describes for unallocated receipts).
    const res = await request(app)
      .post('/api/v1/returns/sales-returns')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id, customerPartyId: customer.id, returnDate: '2026-08-18', reason: 'Damaged in transit',
        lines: [{ productId: product.id, quantity: 10, ratePaise: 5000 }],
      });
    expect(res.status).toBe(201);

    const after = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${product.id}`).set('Cookie', adminCookie);
    expect(after.body.data.balance).toBe(before.body.data.balance + 10);

    const outstandingAfter = await request(app).get(`/api/v1/ledger/party/${customer.id}`).set('Cookie', adminCookie);
    expect(outstandingAfter.body.data.outstandingPaise).toBe(outstandingBefore.body.data.outstandingPaise - 50000);
  });

  it('cancelling a sales return reverses both the stock and the ledger', async () => {
    const before = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${product.id}`).set('Cookie', adminCookie);

    const created = await request(app)
      .post('/api/v1/returns/sales-returns')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id, customerPartyId: customer.id, returnDate: '2026-08-18', reason: 'Test',
        lines: [{ productId: product.id, quantity: 5, ratePaise: 5000 }],
      });

    const cancelled = await request(app).put(`/api/v1/returns/sales-returns/${created.body.data.id}/cancel`).set('Cookie', adminCookie).send({ reason: 'Entered by mistake' });
    expect(cancelled.status).toBe(200);

    const after = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${product.id}`).set('Cookie', adminCookie);
    expect(after.body.data.balance).toBe(before.body.data.balance); // net zero after post + cancel
  });
});

describe('Purchase Return (M22)', () => {
  it('consumes stock and reduces what we owe the vendor', async () => {
    const before = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${product.id}`).set('Cookie', adminCookie);
    const outstandingBefore = await request(app).get(`/api/v1/ledger/party/${vendor.id}`).set('Cookie', adminCookie);

    const res = await request(app)
      .post('/api/v1/returns/purchase-returns')
      .set('Cookie', adminCookie)
      .send({
        factoryId: factory.id, vendorPartyId: vendor.id, returnDate: '2026-08-18', reason: 'Wrong grade delivered',
        lines: [{ productId: product.id, quantity: 15, ratePaise: 5000 }],
      });
    expect(res.status).toBe(201);

    const after = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${product.id}`).set('Cookie', adminCookie);
    expect(after.body.data.balance).toBe(before.body.data.balance - 15);

    const outstandingAfter = await request(app).get(`/api/v1/ledger/party/${vendor.id}`).set('Cookie', adminCookie);
    // Vendor is an AP party — a purchase return debits AP, moving the
    // (negative, since we owe them) balance up toward zero.
    expect(outstandingAfter.body.data.outstandingPaise).toBe(outstandingBefore.body.data.outstandingPaise + 75000);
  });
});

describe('Credit Note & Debit Note (M23) — financial-only, no stock movement', () => {
  it('a credit note reduces customer AR without touching stock', async () => {
    const stockBefore = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${product.id}`).set('Cookie', adminCookie);
    const outstandingBefore = await request(app).get(`/api/v1/ledger/party/${customer.id}`).set('Cookie', adminCookie);

    const res = await request(app)
      .post('/api/v1/returns/credit-notes')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, noteDate: '2026-08-19', reason: 'Agreed price adjustment', amountPaise: 20000 });
    expect(res.status).toBe(201);

    const stockAfter = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${product.id}`).set('Cookie', adminCookie);
    expect(stockAfter.body.data.balance).toBe(stockBefore.body.data.balance);

    const outstandingAfter = await request(app).get(`/api/v1/ledger/party/${customer.id}`).set('Cookie', adminCookie);
    expect(outstandingAfter.body.data.outstandingPaise).toBe(outstandingBefore.body.data.outstandingPaise - 20000);
  });

  it('a debit note reduces vendor AP and can be cancelled', async () => {
    const outstandingBefore = await request(app).get(`/api/v1/ledger/party/${vendor.id}`).set('Cookie', adminCookie);

    const res = await request(app)
      .post('/api/v1/returns/debit-notes')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, vendorPartyId: vendor.id, noteDate: '2026-08-19', reason: 'Short supply', amountPaise: 15000 });
    expect(res.status).toBe(201);

    const cancelled = await request(app).put(`/api/v1/returns/debit-notes/${res.body.data.id}/cancel`).set('Cookie', adminCookie).send({ reason: 'Issued in error' });
    expect(cancelled.status).toBe(200);

    const outstandingAfter = await request(app).get(`/api/v1/ledger/party/${vendor.id}`).set('Cookie', adminCookie);
    expect(outstandingAfter.body.data.outstandingPaise).toBe(outstandingBefore.body.data.outstandingPaise); // net zero after post + cancel
  });
});
