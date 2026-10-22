const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode,
  MixDesign, MixDesignLine, Party, StockLot, Cheque,
} = require('../src/models/index');
const { JournalEntry } = require('../src/api/ledger/journalEntry.model');
const { JournalLine } = require('../src/api/ledger/journalLine.model');
const { Account } = require('../src/api/ledger/account.model');

/**
 * Split payments: one invoice, several tenders, and the books that must agree.
 *
 * The worked example throughout is the brief's own: a ₹63,720 counter sale
 * (54 units @ ₹1,000 + 18% GST) settled as ₹31,860 cash + ₹31,860 UPI. The
 * cashbook must show ₹31,860 — not ₹63,720 — the bank side the other ₹31,860,
 * the customer's receivable must fall by the full amount, and every journal
 * must balance. counter-sale.test.js owns the sale mechanics (stock, GST,
 * cancellation); this file owns the money.
 */

const PASSWORD = 'password123';
let adminCookie;
let factory;
let rawMaterial;
let finishedGood;
let walkIn;
let tenantId;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const counterSale = (body) =>
  request(app).post('/api/v1/retail/counter-sales').set('Cookie', adminCookie).send(body);

const getSale = (id) =>
  request(app).get(`/api/v1/retail/counter-sales/${id}`).set('Cookie', adminCookie);

const postReceipt = (body) =>
  request(app).post('/api/v1/receipts').set('Cookie', adminCookie).send(body);

// 54 @ ₹1,000 → ₹54,000 taxable + 18% GST = ₹63,720 (6,372,000 paise).
const LINES = [{ productId: () => finishedGood.id, quantity: 54, ratePaise: 100000 }];
const TOTAL = 6372000;
const saleLines = () => LINES.map((l) => ({ ...l, productId: l.productId() }));

/** The posted journal for one reference, with its lines and account codes. */
const journalFor = async (referenceType, referenceId) => {
  const entry = await JournalEntry.unscoped().findOne({ where: { referenceType, referenceId } });
  if (!entry) return null;
  const lines = await JournalLine.unscoped().findAll({ where: { journalEntryId: entry.id } });
  const accounts = await Account.unscoped().findAll({ where: { id: lines.map((l) => l.accountId) } });
  const codeById = new Map(accounts.map((a) => [a.id, a.code]));
  return {
    entry,
    lines: lines.map((l) => ({
      code: codeById.get(l.accountId),
      debitPaise: Number(l.debitPaise),
      creditPaise: Number(l.creditPaise),
    })),
  };
};

const sumBy = (lines, code, side) =>
  lines.filter((l) => l.code === code).reduce((sum, l) => sum + l[side], 0);

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Split Pay Co', slug: 'split-pay-co', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Split Pay Pvt Ltd', code: 'SPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@splitpay.test', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Split Factory', code: 'SPL-FAC', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-SPL' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast concrete', gstRatePercent: 18 });
  rawMaterial = await Product.create({ tenantId, uomId: uom.id, name: 'Cement Spl', code: 'RM-CEM-SPL', productType: 'RAW_MATERIAL', curingDays: 0 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Paver Spl', code: 'FG-PAVER-SPL', productType: 'FINISHED_GOOD', curingDays: 0 });
  const mix = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });

  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Spl Vendor' });
  walkIn = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Spl Walk-in', state: 'Odisha', phone: '9861000777' });

  adminCookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@splitpay.test', password: PASSWORD }),
    'accessToken'
  );

  await request(app).post('/api/v1/purchasing/receipts').set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-10', lines: [{ productId: rawMaterial.id, receivedQty: 5000, ratePaise: 5000 }] });
  const produced = await request(app).post('/api/v1/production/entries').set('Cookie', adminCookie)
    .send({ factoryId: factory.id, productId: finishedGood.id, productionDate: '2026-08-15', goodQty: 1000 });
  expect(produced.status).toBe(201);
});

afterAll(async () => {
  await sequelize.close();
});

describe('Example A — ₹63,720 settled as ₹31,860 cash + ₹31,860 UPI', () => {
  let sale;

  beforeAll(async () => {
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-20',
      customer: { partyId: walkIn.id },
      lines: saleLines(),
      payment: {
        modes: [
          { mode: 'CASH', amountPaise: 3186000 },
          { mode: 'UPI', amountPaise: 3186000, reference: 'UPI-UTR-0042' },
        ],
      },
    });
    expect(res.status).toBe(201);
    sale = res.body.data;
  });

  it('is one invoice and one receipt carrying both tenders', () => {
    expect(Number(sale.invoice.totalPaise)).toBe(TOTAL);
    expect(sale.receipt.modes).toHaveLength(2);
    expect(Number(sale.receipt.totalAmountPaise)).toBe(TOTAL);
    expect(sale.receipt.allocations).toHaveLength(1);
    expect(Number(sale.receipt.allocations[0].allocatedAmountPaise)).toBe(TOTAL);
  });

  it('posts a balanced receipt journal: cash ₹31,860, bank ₹31,860, AR −₹63,720', async () => {
    const journal = await journalFor('Receipt', sale.receipt.id);
    expect(journal).not.toBeNull();

    // The cashbook sees only the cash half; UPI lands on the bank side.
    expect(sumBy(journal.lines, '1000', 'debitPaise')).toBe(3186000);
    expect(sumBy(journal.lines, '1010', 'debitPaise')).toBe(3186000);
    expect(sumBy(journal.lines, '1100', 'creditPaise')).toBe(TOTAL);

    const debits = journal.lines.reduce((sum, l) => sum + l.debitPaise, 0);
    const credits = journal.lines.reduce((sum, l) => sum + l.creditPaise, 0);
    expect(debits).toBe(credits);
  });

  it('does not recognise revenue or GST again on the receipt', async () => {
    const journal = await journalFor('Receipt', sale.receipt.id);
    // Revenue (4000) and GST output (21xx) belong to the invoice journal only.
    expect(journal.lines.some((l) => ['4000', '2100', '2110', '2120'].includes(l.code))).toBe(false);
  });

  it('reports the invoice settled, with the method-wise breakdown', async () => {
    const detail = await getSale(sale.invoice.id);
    expect(detail.status).toBe(200);
    expect(Number(detail.body.data.allocatedPaise)).toBe(TOTAL);
    expect(Number(detail.body.data.outstandingPaise)).toBe(0);
    expect(detail.body.data.payments).toHaveLength(1);
    expect(detail.body.data.payments[0].receiptNumber).toMatch(/RCP/);
    expect(detail.body.data.payments[0].modes.map((m) => m.mode).sort()).toEqual(['CASH', 'UPI']);
  });
});

describe('Example B/D — partial split payment, then a later collection', () => {
  let sale;

  beforeAll(async () => {
    // ₹20,000 cash + ₹10,000 UPI against ₹63,720: ₹33,720 stays outstanding.
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-21',
      customer: { partyId: walkIn.id },
      lines: saleLines(),
      payment: {
        modes: [
          { mode: 'CASH', amountPaise: 2000000 },
          { mode: 'UPI', amountPaise: 1000000, reference: 'UPI-UTR-0043' },
        ],
      },
    });
    expect(res.status).toBe(201);
    sale = res.body.data;
  });

  it('allocates exactly what was tendered and leaves the rest outstanding', async () => {
    expect(Number(sale.receipt.totalAmountPaise)).toBe(3000000);
    const detail = await getSale(sale.invoice.id);
    expect(Number(detail.body.data.allocatedPaise)).toBe(3000000);
    expect(Number(detail.body.data.outstandingPaise)).toBe(3372000);
  });

  it('collects the balance later against the same invoice — no new invoice', async () => {
    const res = await postReceipt({
      factoryId: factory.id,
      customerPartyId: walkIn.id,
      receiptDate: '2026-08-25',
      modes: [
        { mode: 'CASH', amountPaise: 1000000 },
        { mode: 'UPI', amountPaise: 2372000, reference: 'UPI-UTR-0044' },
      ],
      allocations: [{ invoiceId: sale.invoice.id, allocatedAmountPaise: 3372000 }],
    });
    expect(res.status).toBe(201);

    const detail = await getSale(sale.invoice.id);
    expect(Number(detail.body.data.outstandingPaise)).toBe(0);
    // Two receipts now stand against the one invoice.
    expect(detail.body.data.payments).toHaveLength(2);
  });

  it('refuses to allocate anything further to the settled invoice', async () => {
    const res = await postReceipt({
      factoryId: factory.id,
      customerPartyId: walkIn.id,
      receiptDate: '2026-08-26',
      modes: [{ mode: 'CASH', amountPaise: 100 }],
      allocations: [{ invoiceId: sale.invoice.id, allocatedAmountPaise: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exceeds the outstanding balance/i);
  });

  it('cancelling the sale reverses both receipts with it', async () => {
    const res = await request(app)
      .post(`/api/v1/retail/counter-sales/${sale.invoice.id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Buyer returned the goods the same week' });
    expect(res.status).toBe(200);
    expect(res.body.data.cancelledReceipts).toHaveLength(2);

    const detail = await getSale(sale.invoice.id);
    expect(detail.body.data.status).toBe('CANCELLED');
    expect(Number(detail.body.data.outstandingPaise)).toBe(0);
    // The breakdown lists only POSTED receipts, so a cancelled sale shows none.
    expect(detail.body.data.payments).toHaveLength(0);
  });
});

describe('Example C — credit sale takes no money', () => {
  it('creates no receipt and leaves the full amount outstanding', async () => {
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-22',
      customer: { partyId: walkIn.id },
      lines: saleLines(),
      payment: null,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.receipt).toBeNull();

    const detail = await getSale(res.body.data.invoice.id);
    expect(Number(detail.body.data.allocatedPaise)).toBe(0);
    expect(Number(detail.body.data.outstandingPaise)).toBe(TOTAL);
    expect(detail.body.data.payments).toHaveLength(0);
  });
});

describe('Example E — a cheque in the split is tracked to clearance', () => {
  it('three tenders on one bill: the cheque gets its lifecycle record', async () => {
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-23',
      customer: { partyId: walkIn.id },
      lines: saleLines(),
      payment: {
        modes: [
          { mode: 'CASH', amountPaise: 1372000 },
          { mode: 'UPI', amountPaise: 2000000, reference: 'UPI-UTR-0045' },
          { mode: 'CHEQUE', amountPaise: 3000000, chequeNumber: '000417', bankName: 'SBI', chequeDate: '2026-08-23' },
        ],
      },
    });
    expect(res.status).toBe(201);

    const cheque = await Cheque.unscoped().findOne({
      where: { receiptId: res.body.data.receipt.id },
    });
    expect(cheque).not.toBeNull();
    expect(cheque.chequeNumber).toBe('000417');
    expect(Number(cheque.amountPaise)).toBe(3000000);
    expect(cheque.status).toBe('ISSUED');

    // Only the cheque's own amount rides its record; the journal still balances.
    const journal = await journalFor('Receipt', res.body.data.receipt.id);
    const debits = journal.lines.reduce((sum, l) => sum + l.debitPaise, 0);
    const credits = journal.lines.reduce((sum, l) => sum + l.creditPaise, 0);
    expect(debits).toBe(credits);
    expect(sumBy(journal.lines, '1000', 'debitPaise')).toBe(1372000);
  });
});

describe('Guard rails', () => {
  it('refuses to collect more than the bill', async () => {
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-24',
      customer: { partyId: walkIn.id },
      lines: saleLines(),
      payment: { modes: [{ mode: 'CASH', amountPaise: TOTAL + 100 }] },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/exceeds the invoice total/i);
  });

  it('an over-tendered sale writes nothing — no invoice, no stock movement', async () => {
    const before = await StockLot.unscoped().findAll({ where: { factoryId: factory.id, productId: finishedGood.id } });
    const beforeQty = before.reduce((sum, l) => sum + Number(l.qtyAvailable), 0);

    await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-24',
      customer: { partyId: walkIn.id },
      lines: saleLines(),
      payment: { modes: [{ mode: 'CASH', amountPaise: TOTAL * 2 }] },
    });

    const after = await StockLot.unscoped().findAll({ where: { factoryId: factory.id, productId: finishedGood.id } });
    const afterQty = after.reduce((sum, l) => sum + Number(l.qtyAvailable), 0);
    expect(afterQty).toBe(beforeQty);
  });

  it('refuses zero, negative and malformed amounts at the schema', async () => {
    for (const amountPaise of [0, -100, 'ten rupees', 1.5]) {
      const res = await counterSale({
        factoryId: factory.id,
        invoiceDate: '2026-08-24',
        customer: { partyId: walkIn.id },
        lines: saleLines(),
        payment: { modes: [{ mode: 'CASH', amountPaise }] },
      });
      expect(res.status).toBe(400);
    }
  });

  it('refuses an empty modes list when payment is being collected', async () => {
    const res = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-24',
      customer: { partyId: walkIn.id },
      lines: saleLines(),
      payment: { modes: [] },
    });
    expect(res.status).toBe(400);
  });

  it('two concurrent collections cannot both settle the same balance', async () => {
    // A credit sale leaves ₹63,720 owing; two racing receipts each try to
    // settle it in full. The invoice row lock serialises them: one wins, one
    // is refused, and the invoice is never over-collected.
    const credit = await counterSale({
      factoryId: factory.id,
      invoiceDate: '2026-08-24',
      customer: { partyId: walkIn.id },
      lines: saleLines(),
      payment: null,
    });
    expect(credit.status).toBe(201);
    const invoiceId = credit.body.data.invoice.id;

    const collect = () =>
      postReceipt({
        factoryId: factory.id,
        customerPartyId: walkIn.id,
        receiptDate: '2026-08-26',
        modes: [{ mode: 'CASH', amountPaise: TOTAL }],
        allocations: [{ invoiceId, allocatedAmountPaise: TOTAL }],
      });

    const [first, second] = await Promise.all([collect(), collect()]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([201, 400]);

    const detail = await getSale(invoiceId);
    expect(Number(detail.body.data.allocatedPaise)).toBe(TOTAL);
    expect(Number(detail.body.data.outstandingPaise)).toBe(0);
  });
});
