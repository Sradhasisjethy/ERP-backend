const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode,
  MixDesign, MixDesignLine, Party,
} = require('../src/models/index');
const { JournalEntry } = require('../src/api/ledger/journalEntry.model');
const { JournalLine } = require('../src/api/ledger/journalLine.model');

/**
 * FR-M18-7, the bounce path.
 *
 * Only cheque *creation* was covered before. The bounce is where the money
 * actually moves: it reverses the receipt that was posted on the strength of
 * the cheque, cancels that receipt so the customer's dues reappear, and books
 * the bank's charge as a real cost.
 *
 * The case that matters most is a bounce with bank charges and no explicit
 * date, because that is what the screen sends — `bouncedAt` is optional on the
 * schema. That path built its ledger date with `new Date().toString().slice(0,
 * 10)`, which yields "Fri Sep 11" rather than "2026-09-11"; Postgres rejects it
 * outright, the transaction rolls back, and the cheque silently stays
 * PRESENTED with the receipt still POSTED.
 */

const PASSWORD = 'password123';
let adminCookie;
let factory;
let finishedGood;
let tenantId;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

/** A counter sale settled by cheque: gives us an invoice, a receipt and a cheque in one step. */
const sellForCheque = async (chequeNumber, amountPaise, quantity) => {
  const res = await request(app).post('/api/v1/retail/counter-sales').set('Cookie', adminCookie).send({
    factoryId: factory.id,
    invoiceDate: '2026-08-20',
    customer: { name: `Cheque Buyer ${chequeNumber}`, phone: `98620000${chequeNumber}` },
    lines: [{ productId: finishedGood.id, quantity, ratePaise: 100000 }],
    payment: {
      modes: [{
        mode: 'CHEQUE', amountPaise,
        chequeNumber: `CHQ-${chequeNumber}`, chequeDate: '2026-08-20', bankName: 'SBI',
      }],
    },
  });
  expect(res.status).toBe(201);
  return res.body.data;
};

const chequeFor = async (chequeNumber) => {
  const res = await request(app).get('/api/v1/cheques?page=1&limit=50').set('Cookie', adminCookie);
  expect(res.status).toBe(200);
  return res.body.data.rows.find((c) => c.chequeNumber === `CHQ-${chequeNumber}`);
};

const outstandingFor = async (invoiceId, customerPartyId) => {
  const res = await request(app)
    .get(`/api/v1/invoices?page=1&limit=50&customerPartyId=${customerPartyId}`)
    .set('Cookie', adminCookie);
  const row = res.body.data.rows.find((i) => i.id === invoiceId);
  return Number(row.outstandingPaise);
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-cheque', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@cheque-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Cheque Factory', code: 'CHQ-FAC', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-CHQ' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast concrete', gstRatePercent: 18 });
  const rawMaterial = await Product.create({ tenantId, uomId: uom.id, name: 'Cement Chq', code: 'RM-CEM-CHQ', productType: 'RAW_MATERIAL', curingDays: 0 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Paver Chq', code: 'FG-PAVER-CHQ', productType: 'FINISHED_GOOD', curingDays: 0 });

  const mix = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });

  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Chq Vendor' });

  adminCookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@cheque-test.co', password: PASSWORD }),
    'accessToken'
  );

  await request(app).post('/api/v1/purchasing/receipts').set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-10', lines: [{ productId: rawMaterial.id, receivedQty: 2000, ratePaise: 5000 }] });

  await request(app).post('/api/v1/production/entries').set('Cookie', adminCookie)
    .send({ factoryId: factory.id, productId: finishedGood.id, productionDate: '2026-08-15', goodQty: 500 });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Bouncing a cheque with bank charges and no explicit date', () => {
  let sale;
  let cheque;
  let bounced;

  beforeAll(async () => {
    sale = await sellForCheque('1', 1180000, 10);
    cheque = await chequeFor('1');
    await request(app).put(`/api/v1/cheques/${cheque.id}/present`).set('Cookie', adminCookie).send({});

    // No bouncedAt — exactly what the screen sends, and the case that failed.
    bounced = await request(app)
      .put(`/api/v1/cheques/${cheque.id}/bounce`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Insufficient funds', bankChargesPaise: 50000 });
  });

  it('succeeds instead of failing on a malformed ledger date', () => {
    expect(bounced.status).toBe(200);
    expect(bounced.body.data.status).toBe('BOUNCED');
  });

  it('books the bank charge against a date Postgres accepts', async () => {
    const entry = await JournalEntry.findOne({ where: { referenceType: 'Cheque', referenceId: cheque.id } });
    expect(entry).toBeTruthy();
    // The whole bug in one assertion: "Fri Sep 11" never reaches the column.
    expect(String(entry.entryDate)).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('charges the bank fee to expense and takes it out of the bank', async () => {
    const entry = await JournalEntry.findOne({ where: { referenceType: 'Cheque', referenceId: cheque.id } });
    const lines = await JournalLine.findAll({ where: { journalEntryId: entry.id } });
    const debits = lines.reduce((s, l) => s + Number(l.debitPaise), 0);
    const credits = lines.reduce((s, l) => s + Number(l.creditPaise), 0);
    expect(debits).toBe(50000);
    expect(credits).toBe(50000);
  });

  it('cancels the receipt the cheque had paid for', async () => {
    const res = await request(app).get(`/api/v1/receipts/${sale.receipt.id}`).set('Cookie', adminCookie);
    expect(res.body.data.status).toBe('CANCELLED');
  });

  it('puts the money back on the customer as due again', async () => {
    // Before the bounce this invoice was fully settled. A bounce that leaves it
    // looking paid is how a debt quietly disappears.
    expect(await outstandingFor(sale.invoice.id, sale.customer.id)).toBe(1180000);
  });

  it('leaves the books balanced', async () => {
    const lines = await JournalLine.findAll();
    const debits = lines.reduce((s, l) => s + Number(l.debitPaise), 0);
    const credits = lines.reduce((s, l) => s + Number(l.creditPaise), 0);
    expect(debits).toBe(credits);
  });
});

describe('Bouncing without bank charges', () => {
  it('reverses the receipt and posts no charge entry', async () => {
    const sale = await sellForCheque('2', 590000, 5);
    const cheque = await chequeFor('2');
    await request(app).put(`/api/v1/cheques/${cheque.id}/present`).set('Cookie', adminCookie).send({});

    const res = await request(app)
      .put(`/api/v1/cheques/${cheque.id}/bounce`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Signature mismatch' });

    expect(res.status).toBe(200);
    expect(await outstandingFor(sale.invoice.id, sale.customer.id)).toBe(590000);

    // No charge was incurred, so no entry should exist for it.
    const entry = await JournalEntry.findOne({ where: { referenceType: 'Cheque', referenceId: cheque.id } });
    expect(entry).toBeNull();
  });
});

describe('An explicitly dated bounce', () => {
  it('books the charge on the date given, not today', async () => {
    const sale = await sellForCheque('3', 236000, 2);
    const cheque = await chequeFor('3');
    await request(app).put(`/api/v1/cheques/${cheque.id}/present`).set('Cookie', adminCookie).send({});

    const res = await request(app)
      .put(`/api/v1/cheques/${cheque.id}/bounce`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Account closed', bankChargesPaise: 25000, bouncedAt: '2026-08-25' });

    expect(res.status).toBe(200);
    const entry = await JournalEntry.findOne({ where: { referenceType: 'Cheque', referenceId: cheque.id } });
    expect(String(entry.entryDate)).toBe('2026-08-25');
    expect(sale.invoice.id).toBeTruthy();
  });
});

describe('Lifecycle rules still hold', () => {
  it('refuses to bounce a cheque that was never presented', async () => {
    await sellForCheque('4', 118000, 1);
    const cheque = await chequeFor('4');

    const res = await request(app)
      .put(`/api/v1/cheques/${cheque.id}/bounce`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Too early', bankChargesPaise: 10000 });

    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot go from ISSUED to BOUNCED/i);
  });

  it('refuses to bounce the same cheque twice', async () => {
    const cheque = await chequeFor('2');
    const res = await request(app)
      .put(`/api/v1/cheques/${cheque.id}/bounce`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Again' });
    expect(res.status).toBe(400);
  });

  it('requires a reason', async () => {
    await sellForCheque('5', 118000, 1);
    const cheque = await chequeFor('5');
    await request(app).put(`/api/v1/cheques/${cheque.id}/present`).set('Cookie', adminCookie).send({});

    const res = await request(app)
      .put(`/api/v1/cheques/${cheque.id}/bounce`)
      .set('Cookie', adminCookie)
      .send({ bankChargesPaise: 10000 });
    expect(res.status).toBe(400);
  });
});
