/**
 * Regression tests for findings I2, I5 and I10 of the 2026-10-09 review.
 *
 * I2: a receipt could list the same invoice twice. Each line was checked
 * against what the database already held, so both passed and the invoice was
 * settled beyond its total.
 *
 * I5: a till count accepted any positive key as a note value, so
 * { "1e12": 1 } counted as ₹10^12 and, with postAdjustment, posted a journal.
 *
 * I10: search terms went into ILIKE unescaped, so "_" matched every row.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { runInTenantContext } = require('./helpers/tenant');
const { PaymentsService } = require('../src/api/payments/payments.service');
const { countDenominations } = require('../src/api/cashRegister/cashRegister.service');
const { containsPattern } = require('../src/utils/pagination');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party, PaymentAllocation, SalesInvoice,
} = require('../src/models/index');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

let T;

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Inputs Co', slug: 'inputs-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Inputs Pvt Ltd', code: 'IN' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'ACTIVE' });
  const plant = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant', code: 'IPL', state: 'Odisha', allowNegativeCash: true });
  await User.create(
    { tenantId, email: 'admin@inputs.test', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'A', lastName: 'A', role: 'PLATFORM_ADMIN', status: 'ACTIVE' },
    { validate: false }
  );

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-IN' });
  await Product.create({ tenantId, uomId: uom.id, name: 'A1', code: 'A1', productType: 'FINISHED_GOOD' });
  await Product.create({ tenantId, uomId: uom.id, name: 'B2', code: 'B2', productType: 'FINISHED_GOOD' });
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Inputs Customer', state: 'Odisha' });

  // Built directly, as in cross-tenant-references.test.js: allocation only
  // reads status, plant, customer and total.
  const invoice = (invoiceNumber) => SalesInvoice.create({
    tenantId, factoryId: plant.id, invoiceNumber, customerPartyId: customer.id,
    invoiceDate: '2026-08-17', subtotalPaise: 1000, totalPaise: 1000, status: 'POSTED',
  });

  T = { tenantId, plant, customer, invoiceHttp: await invoice('INV-IN-1'), invoiceDirect: await invoice('INV-IN-2') };
  T.cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@inputs.test', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

const post = (path, body) => request(app).post(path).set('Cookie', T.cookie).send(body);
const put = (path, body) => request(app).put(path).set('Cookie', T.cookie).send(body);
const get = (path, query) => request(app).get(path).set('Cookie', T.cookie).query(query || {});
const allocationsTo = (invoiceId) => PaymentAllocation.unscoped().count({ where: { invoiceId } });

describe('I2: one receipt cannot list the same invoice twice', () => {
  const receipt = (invoiceId, amounts) => ({
    factoryId: T.plant.id, customerPartyId: T.customer.id, receiptDate: '2026-08-18',
    modes: [{ mode: 'CASH', amountPaise: amounts.reduce((a, b) => a + b, 0) }],
    allocations: amounts.map((allocatedAmountPaise) => ({ invoiceId, allocatedAmountPaise })),
  });

  it('400s two allocations of 600 to a 1000 invoice and writes nothing', async () => {
    const res = await post('/api/v1/receipts', receipt(T.invoiceHttp.id, [600, 600]));
    expect(res.status).toBe(400);
    expect(await allocationsTo(T.invoiceHttp.id)).toBe(0);
  });

  it('control: a second receipt of 600 is refused after a first of 600', async () => {
    expect((await post('/api/v1/receipts', receipt(T.invoiceHttp.id, [600]))).status).toBe(201);
    const second = await post('/api/v1/receipts', receipt(T.invoiceHttp.id, [600]));
    expect(second.status).toBe(400);
    expect(await allocationsTo(T.invoiceHttp.id)).toBe(1);
  });

  it('the service itself refuses duplicates that bypass the schema', async () => {
    const body = receipt(T.invoiceDirect.id, [600, 600]);
    await expect(runInTenantContext(T.tenantId, () => PaymentsService.createReceipt(body)))
      .rejects.toThrow(/outstanding balance/);
    expect(await allocationsTo(T.invoiceDirect.id)).toBe(0);
  });
});

describe('I5: a till count only takes real notes and coins', () => {
  it('refuses a made-up note value', async () => {
    const opened = await post('/api/v1/cash-register/sessions', { factoryId: T.plant.id, denominations: {} });
    expect(opened.status).toBe(201);
    const id = opened.body.data.id;

    const bad = await put(`/api/v1/cash-register/sessions/${id}/close`, { denominations: { '1e12': 1 }, postAdjustment: true });
    expect(bad.status).toBe(400);

    const overCount = await put(`/api/v1/cash-register/sessions/${id}/close`, { denominations: { 500: 2000001 } });
    expect(overCount.status).toBe(400);

    // Positive control: a real count closes the same session.
    const ok = await put(`/api/v1/cash-register/sessions/${id}/close`, { denominations: { 500: 2 } });
    expect(ok.status).toBe(200);
    expect(Number(ok.body.data.closingCountedPaise)).toBe(100000);
  });

  it('countDenominations rejects non-canonical keys the schema would also refuse', () => {
    expect(() => countDenominations({ '1e3': 1 })).toThrow(/not a note or coin/);
    expect(() => countDenominations({ '0500': 1 })).toThrow(/not a note or coin/);
    expect(() => countDenominations({ 500: 1.5 })).toThrow(/whole number/);
    expect(countDenominations({ 2000: 1, 1: 3 })).toBe(200300);
  });
});

describe('I10: search terms match literally', () => {
  it('escapes ILIKE metacharacters', () => {
    expect(containsPattern('50%_a\\b')).toBe('%50\\%\\_a\\\\b%');
  });

  it('"_" matches no product; "A" matches one', async () => {
    const underscore = await get('/api/v1/products', { search: '_' });
    expect(underscore.status).toBe(200);
    expect(underscore.body.data.rows).toHaveLength(0);

    const a = await get('/api/v1/products', { search: 'A' });
    expect(a.status).toBe(200);
    expect(a.body.data.rows.map((p) => p.code)).toEqual(['A1']);
  });
});
