const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, HsnCode, Product, Party,
  JournalEntry, JournalLine, Account,
} = require('../src/models/index');

/**
 * Finance reconciliation.
 *
 * Runs a complete trading period — sales, purchases, returns, expenses,
 * receipts and payments — then proves the books are internally consistent:
 *
 *   1. every journal entry balances;
 *   2. the trial balance sums to zero;
 *   3. each control account equals the sum of its parties' statements;
 *   4. cash movement equals opening + in − out;
 *   5. the reports agree with the journal they are built on.
 *
 * The brief says not to declare PASS if ledger and transaction data cannot be
 * reconciled. This is that reconciliation.
 */

const PASSWORD = 'password123';
let cookie;
let F;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const get = (p) => request(app).get(p).set('Cookie', cookie);
const post = (p, b) => request(app).post(p).set('Cookie', cookie).send(b);
const put = (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {});

const accountNet = async (code) => {
  const account = await Account.findOne({ where: { code } });
  if (!account) return 0;
  const lines = await JournalLine.findAll({ where: { accountId: account.id } });
  return lines.reduce((s, l) => s + Number(l.debitPaise) - Number(l.creditPaise), 0);
};

const trail = [];

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Books Co', slug: 'books-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Books Pvt Ltd', code: 'BC' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@books.test', passwordHash, firstName: 'A', lastName: 'A', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant', code: 'PL', state: 'Odisha', dispatchTolerancePercent: 0 });
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', gstRatePercent: 18 });
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Konark Infra', state: 'Odisha' });
  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Odisha Cement', state: 'Odisha' });
  F = { tenantId, factory, uom, hsn, customer, vendor };
  cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@books.test', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('Finance reconciliation — a full trading period', () => {
  let slab;
  let cement;
  let salesInvoice;
  let vendorBill;

  it('1. Buy raw material and book the vendor bill', async () => {
    cement = (await post('/api/v1/products', { uomId: F.uom.id, name: 'Cement', code: 'RM-CEM', productType: 'RAW_MATERIAL' })).body.data;
    const grn = await post('/api/v1/purchasing/receipts', {
      factoryId: F.factory.id, vendorPartyId: F.vendor.id, receiptDate: '2026-08-01',
      lines: [{ productId: cement.id, receivedQty: 1000, ratePaise: 4000 }],
    });
    expect(grn.status).toBe(201);

    const bill = await post('/api/v1/purchasing/invoices', {
      factoryId: F.factory.id, goodsReceiptId: grn.body.data.id, vendorPartyId: F.vendor.id,
      vendorInvoiceNumber: 'OCC/001', invoiceDate: '2026-08-02', amountPaise: 4000000,
    });
    expect(bill.status).toBe(201);
    vendorBill = bill.body.data;

    expect(await accountNet('5000')).toBe(4000000);   // Purchase Expense (Dr)
    expect(await accountNet('2000')).toBe(-4000000);  // Accounts Payable (Cr)
    trail.push(['vendor bill 40,000.00', await accountNet('2000')]);
  });

  it('2. Sell finished goods and raise the sales invoice', async () => {
    slab = (await post('/api/v1/products', {
      uomId: F.uom.id, hsnId: F.hsn.id, name: 'Slab', code: 'FG-SLAB', productType: 'FINISHED_GOOD',
    })).body.data;
    await post('/api/v1/purchasing/receipts', {
      factoryId: F.factory.id, vendorPartyId: F.vendor.id, receiptDate: '2026-08-03',
      lines: [{ productId: slab.id, receivedQty: 100, ratePaise: 1000 }],
    });

    const order = await post('/api/v1/sales/orders', {
      factoryId: F.factory.id, customerPartyId: F.customer.id, orderDate: '2026-08-04',
      lines: [{ productId: slab.id, orderedQty: 100, ratePaise: 100000 }],
    });
    const confirmed = await put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    const challan = await post('/api/v1/dispatch/challans', {
      salesOrderId: order.body.data.id, vehicleNumber: 'OD-01', dispatchDate: '2026-08-05',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 100 }],
    });
    const invoice = await post('/api/v1/invoices', { challanIds: [challan.body.data.id], invoiceDate: '2026-08-06' });
    expect(invoice.status).toBe(201);
    salesInvoice = invoice.body.data;

    // Revenue 10,00,000 + 18% GST, rounded. AR carries the gross.
    expect(await accountNet('4000')).toBe(-10000000);
    expect(await accountNet('1100')).toBe(Number(salesInvoice.totalPaise));
    trail.push(['sales invoice', await accountNet('1100')]);
  });

  it('3. Take the customer\'s money, in two parts', async () => {
    const due = Number(salesInvoice.totalPaise);
    const half = Math.floor(due / 2);
    for (const [amount, ref] of [[half, 'UTR-1'], [due - half, 'UTR-2']]) {
      const r = await post('/api/v1/receipts', {
        factoryId: F.factory.id, customerPartyId: F.customer.id, receiptDate: '2026-08-07',
        modes: [{ mode: 'BANK', amountPaise: amount, reference: ref }],
        allocations: [{ invoiceId: salesInvoice.id, allocatedAmountPaise: amount }],
      });
      expect(r.status).toBe(201);
    }
    // Receivable fully cleared; the money is in the bank.
    expect(await accountNet('1100')).toBe(0);
    expect(await accountNet('1010')).toBe(due);
    trail.push(['customer paid in full', await accountNet('1100')]);
  });

  it('4. Return some material to the vendor and pay the balance', async () => {
    const lot = await require('../src/models/index').StockLot.findOne({ where: { productId: cement.id } });
    const ret = await post('/api/v1/returns/purchase-returns', {
      factoryId: F.factory.id, vendorPartyId: F.vendor.id, returnDate: '2026-08-08', reason: 'wet bags',
      lines: [{ productId: cement.id, lotId: lot.id, quantity: 100, ratePaise: 4000 }],
    });
    expect(ret.status).toBe(201);
    // Payable reduced by 4,00,000.
    expect(await accountNet('2000')).toBe(-3600000);

    const pay = await post('/api/v1/payments', {
      factoryId: F.factory.id, partyId: F.vendor.id, paymentDate: '2026-08-09',
      modes: [{ mode: 'BANK', amountPaise: 4000000, reference: 'UTR-V' }],
      allocations: [{ invoiceId: vendorBill.id, allocatedAmountPaise: 4000000 }],
    });
    expect(pay.status).toBe(201);
    // Bill settled in full; the return sits as a credit with the vendor.
    expect(await accountNet('2000')).toBe(400000);
    trail.push(['vendor bill paid, return outstanding', await accountNet('2000')]);
  });

  it('5. Pay some expenses', async () => {
    await post('/api/v1/expenses', {
      factoryId: F.factory.id, expenseDate: '2026-08-10', category: 'Fuel', mode: 'BANK', amountPaise: 150000,
    });
    await post('/api/v1/expenses', {
      factoryId: F.factory.id, expenseDate: '2026-08-11', category: 'Repairs', mode: 'BANK', amountPaise: 90000,
    });
    expect(await accountNet('5900')).toBe(240000);
    trail.push(['expenses paid', await accountNet('5900')]);
  });

  it('RECONCILES: the books balance and every control account ties out', async () => {
    // 1. Every entry balances internally.
    const entries = await JournalEntry.findAll({ include: [{ model: JournalLine, as: 'lines' }] });
    for (const e of entries) {
      const d = e.lines.reduce((s, l) => s + Number(l.debitPaise), 0);
      const c = e.lines.reduce((s, l) => s + Number(l.creditPaise), 0);
      expect([e.id, d]).toEqual([e.id, c]);
    }

    // 2. The books balance in aggregate.
    const allLines = await JournalLine.findAll();
    const totalDebit = allLines.reduce((s, l) => s + Number(l.debitPaise), 0);
    const totalCredit = allLines.reduce((s, l) => s + Number(l.creditPaise), 0);
    expect(totalDebit).toBe(totalCredit);

    // 3. The trial balance sums to zero.
    const tb = await get(`/api/v1/ledger/trial-balance?factoryId=${F.factory.id}`);
    expect(tb.body.data.reduce((s, r) => s + Number(r.balancePaise), 0)).toBe(0);

    // 4. Each control account equals the sum of its parties' statements —
    //    the check that catches a posting that reached the account but not
    //    the party, or vice versa.
    const customerStmt = await get(`/api/v1/ledger/party/${F.customer.id}?page=1&limit=100`);
    const vendorStmt = await get(`/api/v1/ledger/party/${F.vendor.id}?page=1&limit=100`);

    // Customer: receivable, debit-positive. Fully settled.
    expect(Number(customerStmt.body.data.outstandingPaise)).toBe(0);
    expect(Number(customerStmt.body.data.closingBalancePaise)).toBe(0);
    expect(await accountNet('1100')).toBe(0);

    // Vendor: payable, credit-positive. We over-paid by the return value, so
    // the vendor now owes US 4,00,000 — a negative payable, correctly signed.
    expect(Number(vendorStmt.body.data.outstandingPaise)).toBe(-400000);
    expect(await accountNet('2000')).toBe(400000);
    expect(Number(vendorStmt.body.data.outstandingPaise)).toBe(-(await accountNet('2000')));

    // 5. Each statement's running balance is internally consistent.
    for (const stmt of [customerStmt, vendorStmt]) {
      let running = Number(stmt.body.data.openingBalancePaise);
      const payableSide = stmt === vendorStmt;
      for (const row of stmt.body.data.rows) {
        running += payableSide
          ? Number(row.creditPaise) - Number(row.debitPaise)
          : Number(row.debitPaise) - Number(row.creditPaise);
        expect([row.id, Number(row.runningBalancePaise)]).toEqual([row.id, running]);
      }
      expect(Number(stmt.body.data.closingBalancePaise)).toBe(running);
    }
  });

  it('RECONCILES: bank movement equals opening + in − out', async () => {
    const book = await get(`/api/v1/ledger/cash-book?factoryId=${F.factory.id}&accountKey=BANK`);
    expect(book.status).toBe(200);
    const b = book.body.data;

    expect(Number(b.openingBalancePaise) + Number(b.totalInPaise) - Number(b.totalOutPaise)).toBe(Number(b.closingBalancePaise));
    // ...and the closing figure is the account's real balance.
    expect(Number(b.closingBalancePaise)).toBe(await accountNet('1010'));

    // A window that starts mid-period carries everything before it.
    const windowed = await get(`/api/v1/ledger/cash-book?factoryId=${F.factory.id}&accountKey=BANK&from=2026-08-10&to=2026-08-31`);
    const w = windowed.body.data;
    expect(Number(w.openingBalancePaise) + Number(w.totalInPaise) - Number(w.totalOutPaise)).toBe(Number(w.closingBalancePaise));
    expect(Number(w.closingBalancePaise)).toBe(Number(b.closingBalancePaise));
    // Only the two expenses fall inside the window.
    expect(Number(w.totalOutPaise)).toBe(240000);
  });

  it('RECONCILES: the reports agree with the journal', async () => {
    const dayBook = await get(`/api/v1/reports/finance/day-book?factoryId=${F.factory.id}&page=1&limit=200`);
    expect(dayBook.status).toBe(200);
    const d = dayBook.body.data.rows.reduce((s, r) => s + Number(r.debitPaise || 0), 0);
    const c = dayBook.body.data.rows.reduce((s, r) => s + Number(r.creditPaise || 0), 0);
    expect(d).toBe(c);

    for (const path of ['customer/ledger', 'vendor/ledger', 'finance/receivables', 'finance/payables', 'payment/register', 'expense/register', 'finance/cash-flow']) {
      const res = await get(`/api/v1/reports/${path}?factoryId=${F.factory.id}&page=1&limit=50`);
      expect([path, res.status]).toEqual([path, 200]);
    }

    // The expense report agrees with the expense account.
    const expenses = await get(`/api/v1/reports/expense/register?factoryId=${F.factory.id}&page=1&limit=50`);
    expect(Number(expenses.body.data.summary.amountPaise)).toBe(await accountNet('5900'));

    // eslint-disable-next-line no-console
    console.log('\n  Ledger trail:\n' + trail.map(([label, v]) => `    ${label.padEnd(38)} ${String(v).padStart(10)}`).join('\n'));
  });
});
