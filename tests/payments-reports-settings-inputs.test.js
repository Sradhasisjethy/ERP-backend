/**
 * Regression tests for findings N1, N2, N6, N9 and N10 of the 2026-10-09 review.
 *
 * N1: the duplicate-invoice check compared raw strings, but Postgres compares
 * uuids case-insensitively — one invoice listed upper- and lower-case was two
 * lines to the check and settled twice.
 *
 * N2: payment dates were free strings ('05/06/2026' reached Postgres to be
 * guessed at); strings and amounts had no upper bound.
 *
 * N6: the migration import stored any GSTIN or email.
 *
 * N9: a saved report's stored params were never validated, only the overrides.
 *
 * N10: a bad `locale` setting made every report export throw.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { runInTenantContext } = require('./helpers/tenant');
const { PaymentsService } = require('../src/api/payments/payments.service');
const { presentSchema, bounceSchema, createReceiptSchema } = require('../src/api/payments/payments.schema');
const { safeLocale } = require('../src/api/reports/export/format');
const {
  Tenant, User, Organization, Factory, FinancialYear, Party, PaymentAllocation, SalesInvoice, SavedReport,
} = require('../src/models/index');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

let T;

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'PRS Co', slug: 'prs-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'PRS Pvt Ltd', code: 'PRS' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'ACTIVE' });
  const plant = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant', code: 'PRS', state: 'Odisha', allowNegativeCash: true });
  await User.create(
    { tenantId, email: 'admin@prs.test', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'A', lastName: 'A', role: 'PLATFORM_ADMIN', status: 'ACTIVE' },
    { validate: false }
  );
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'PRS Customer', state: 'Odisha' });

  // Built directly, as in money-and-search-inputs.test.js: allocation only
  // reads status, plant, customer and total.
  const invoice = (invoiceNumber) => SalesInvoice.create({
    tenantId, factoryId: plant.id, invoiceNumber, customerPartyId: customer.id,
    invoiceDate: '2026-08-17', subtotalPaise: 1000, totalPaise: 1000, status: 'POSTED',
  });

  T = { tenantId, plant, customer, invoiceHttp: await invoice('INV-PRS-1'), invoiceDirect: await invoice('INV-PRS-2') };
  T.cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@prs.test', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

const post = (path, body) => request(app).post(path).set('Cookie', T.cookie).send(body);
const put = (path, body) => request(app).put(path).set('Cookie', T.cookie).send(body);
const allocationsTo = (invoiceId) => PaymentAllocation.unscoped().count({ where: { invoiceId } });

const receipt = (allocations, overrides = {}) => ({
  factoryId: T.plant.id, customerPartyId: T.customer.id, receiptDate: '2026-08-18',
  modes: [{ mode: 'CASH', amountPaise: allocations.reduce((sum, a) => sum + a.allocatedAmountPaise, 0) || 100 }],
  allocations,
  ...overrides,
});

describe('N1: an invoice id in two cases is still one invoice', () => {
  it('400s 600 + 600 to a 1000 invoice when one id is upper-case, and writes nothing', async () => {
    const id = T.invoiceHttp.id;
    const res = await post('/api/v1/receipts', receipt([
      { invoiceId: id.toUpperCase(), allocatedAmountPaise: 600 },
      { invoiceId: id, allocatedAmountPaise: 600 },
    ]));
    expect(res.status).toBe(400);
    expect(await allocationsTo(id)).toBe(0);
  });

  it('the service lower-cases ids itself and writes one line per invoice', async () => {
    const id = T.invoiceDirect.id;
    const body = receipt([
      { invoiceId: id.toUpperCase(), allocatedAmountPaise: 300 },
      { invoiceId: id, allocatedAmountPaise: 300 },
    ]);
    await runInTenantContext(T.tenantId, () => PaymentsService.createReceipt(body));
    const rows = await PaymentAllocation.unscoped().findAll({ where: { invoiceId: id } });
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].allocatedAmountPaise)).toBe(600);

    // And the running total still holds across the two cases: 600 + 500 > 1000.
    const over = receipt([{ invoiceId: id.toUpperCase(), allocatedAmountPaise: 500 }]);
    await expect(runInTenantContext(T.tenantId, () => PaymentsService.createReceipt(over)))
      .rejects.toThrow(/outstanding balance/);
  });

  it('the database refuses a second line for the same receipt and invoice', async () => {
    const [existing] = await PaymentAllocation.unscoped().findAll({ where: { invoiceId: T.invoiceDirect.id } });
    await expect(
      sequelize.query(
        `INSERT INTO payment_allocations (id, "tenantId", "receiptId", "invoiceType", "invoiceId", "allocatedAmountPaise", "createdAt", "updatedAt")
         VALUES (gen_random_uuid(), :tenantId, :receiptId, 'SALES', :invoiceId, 1, now(), now())`,
        { replacements: { tenantId: T.tenantId, receiptId: existing.receiptId, invoiceId: T.invoiceDirect.id.toUpperCase() } }
      )
    ).rejects.toMatchObject({ name: 'SequelizeUniqueConstraintError' });
  });
});

describe('N2: payment dates and bounds', () => {
  it('400s a receiptDate that is not YYYY-MM-DD', async () => {
    const res = await post('/api/v1/receipts', receipt([], { receiptDate: '05/06/2026', allocations: undefined }));
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/receiptDate/);
  });

  it('cheque moments take a date or an offset timestamp, nothing else', () => {
    const ok = (schema, body) => schema.safeParse({ body }).success;
    expect(ok(presentSchema, {})).toBe(true);
    expect(ok(presentSchema, { presentedAt: '2026-08-20' })).toBe(true);
    expect(ok(presentSchema, { presentedAt: '2026-08-20T10:30:00+05:30' })).toBe(true);
    expect(ok(presentSchema, { presentedAt: '20/08/2026' })).toBe(false);
    expect(ok(presentSchema, { presentedAt: '2026-02-30T10:00:00Z' })).toBe(false);
    expect(ok(bounceSchema, { reason: 'x'.repeat(5001) })).toBe(false);
    expect(ok(bounceSchema, { reason: 'Insufficient funds', bankChargesPaise: Number.MAX_SAFE_INTEGER + 2 })).toBe(false);
  });

  it('caps reference strings and mode amounts', () => {
    const body = (mode) => ({ factoryId: T.plant.id, customerPartyId: T.customer.id, receiptDate: '2026-08-18', modes: [mode] });
    expect(createReceiptSchema.safeParse({ body: body({ mode: 'UPI', amountPaise: 100, reference: 'r'.repeat(256) }) }).success).toBe(false);
    expect(createReceiptSchema.safeParse({ body: body({ mode: 'CASH', amountPaise: 1e300 }) }).success).toBe(false);
    expect(createReceiptSchema.safeParse({ body: body({ mode: 'CHEQUE', amountPaise: 100, chequeDate: '2026-13-01' }) }).success).toBe(false);
    expect(createReceiptSchema.safeParse({ body: body({ mode: 'CASH', amountPaise: 100 }) }).success).toBe(true);
  });
});

describe('N6: migration import checks GSTIN and email', () => {
  it('reports a bad GSTIN and a bad email per row, and imports nothing', async () => {
    const res = await post('/api/v1/migration/import', {
      kind: 'parties',
      rows: [
        { partyType: 'CUSTOMER', name: 'Bad GSTIN Ltd', gstin: 'BAD' },
        { partyType: 'CUSTOMER', name: 'Bad Email Ltd', email: 'not-an-email' },
        { partyType: 'CUSTOMER', name: 'L'.repeat(256) },
      ],
    });
    expect(res.status).toBe(422);
    const errors = res.body.data.errors;
    expect(errors).toEqual(expect.arrayContaining([
      expect.objectContaining({ row: 2, field: 'gstin' }),
      expect.objectContaining({ row: 3, field: 'email' }),
      expect.objectContaining({ row: 4, field: 'name' }),
    ]));
    expect(await Party.unscoped().count({ where: { name: 'Bad GSTIN Ltd' } })).toBe(0);
  });

  it('control: a valid lower-case GSTIN imports, stored upper-case', async () => {
    const res = await post('/api/v1/migration/import', {
      kind: 'parties',
      rows: [{ partyType: 'CUSTOMER', name: 'Good GSTIN Ltd', gstin: ' 21abcde1234f1z5 ', email: 'ap@good.test' }],
    });
    expect(res.status).toBe(200);
    const party = await Party.unscoped().findOne({ where: { name: 'Good GSTIN Ltd' } });
    expect(party.gstin).toBe('21ABCDE1234F1Z5');
  });
});

describe('N9: a saved report runs only with valid merged params', () => {
  it('400s a stored { q: {} } and names the key, not the value', async () => {
    const saved = await runInTenantContext(T.tenantId, () =>
      SavedReport.create({ tenantId: T.tenantId, name: 'Broken search', reportType: 'DOCUMENT_SEARCH', params: { q: {} } }));
    const res = await post(`/api/v1/reports/${saved.id}/run`, {});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/\bq\b/);
    expect(res.body.message).not.toMatch(/\{\}/);
  });

  it('control: a valid override repairs it', async () => {
    const saved = await runInTenantContext(T.tenantId, () =>
      SavedReport.create({ tenantId: T.tenantId, name: 'Fixable search', reportType: 'DOCUMENT_SEARCH', params: { q: {} } }));
    const res = await post(`/api/v1/reports/${saved.id}/run`, { params: { q: 'INV' } });
    expect(res.status).toBe(200);
  });
});

describe('N10: locale setting', () => {
  it('refuses a locale Intl rejects and accepts a real one', async () => {
    expect((await put('/api/v1/settings/locale', { value: 'en_IN' })).status).toBe(400);
    expect((await put('/api/v1/settings/locale', { value: 'en-IN' })).status).toBe(200);
    expect((await put('/api/v1/settings/timezone', { value: 'Mars/Olympus_Mons' })).status).toBe(400);
    expect((await put('/api/v1/settings/currency', { value: 'inr' })).status).toBe(400);
  });

  it('an export still renders when a bad locale is already stored', async () => {
    // Written past the API, as an older row or a direct edit would be.
    await sequelize.query(
      `UPDATE tenant_settings SET value = '"en_IN"'::jsonb WHERE "tenantId" = :tenantId AND key = 'locale'`,
      { replacements: { tenantId: T.tenantId } }
    );
    expect(safeLocale('en_IN')).toBe('en-IN');

    const csv = await request(app)
      .get('/api/v1/reports/sales/summary/export')
      .set('Cookie', T.cookie)
      .query({ format: 'csv' });
    expect(csv.status).toBe(200);
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
  });
});
