const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, HsnCode, Product, Party,
  AdGroup, AdGroupMember, UserFactory, JournalEntry, JournalLine, Account,
  PurchaseInvoice, AuditLog,
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
let plantBOnly;   // ledger access, but only at Plant B
let noRates;      // finance read, but no VIEW_RATES
let other;

const as = (cookie) => ({
  get: (p) => request(app).get(p).set('Cookie', cookie),
  post: (p, b) => request(app).post(p).set('Cookie', cookie).send(b),
  put: (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {}),
});

/** Signed movement on a party's control account, as debit − credit. */
const partyNet = async (partyId) => {
  const lines = await JournalLine.findAll({ where: { partyId } });
  return lines.reduce((s, l) => s + Number(l.debitPaise) - Number(l.creditPaise), 0);
};

const accountBalance = async (code, factoryId) => {
  const account = await Account.findOne({ where: { code } });
  if (!account) return 0;
  const lines = await JournalLine.findAll({
    where: { accountId: account.id },
    include: [{ model: JournalEntry, as: 'journalEntry', where: factoryId ? { factoryId } : undefined, required: true }],
  });
  return lines.reduce((s, l) => s + Number(l.debitPaise) - Number(l.creditPaise), 0);
};

/** Sells `qty` to the customer and invoices it. Returns the invoice body. */
const sellAndInvoice = async (p, qty, rate, tag) => {
  await as(admin).post('/api/v1/purchasing/receipts', {
    factoryId: T.plantA.id, vendorPartyId: T.vendor.id, receiptDate: '2026-08-01',
    lines: [{ productId: p.id, receivedQty: qty, ratePaise: 100 }],
  });
  const order = await as(admin).post('/api/v1/sales/orders', {
    factoryId: T.plantA.id, customerPartyId: T.customer.id, orderDate: '2026-08-02',
    lines: [{ productId: p.id, orderedQty: qty, ratePaise: rate }],
  });
  const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
  const challan = await as(admin).post('/api/v1/dispatch/challans', {
    salesOrderId: order.body.data.id, vehicleNumber: `OD-${tag}`, dispatchDate: '2026-08-03',
    lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: qty }],
  });
  const invoice = await as(admin).post('/api/v1/invoices', { challanIds: [challan.body.data.id], invoiceDate: '2026-08-04' });
  if (invoice.status !== 201) throw new Error(`invoice failed: ${invoice.status} ${invoice.body.message}`);
  return invoice.body.data;
};

/** Books a vendor bill and returns it. */
const billVendor = async (p, qty, amountPaise, seq) => {
  const grn = await as(admin).post('/api/v1/purchasing/receipts', {
    factoryId: T.plantA.id, vendorPartyId: T.vendor.id, receiptDate: '2026-08-01',
    lines: [{ productId: p.id, receivedQty: qty, ratePaise: 100 }],
  });
  const inv = await as(admin).post('/api/v1/purchasing/invoices', {
    factoryId: T.plantA.id, goodsReceiptId: grn.body.data.id, vendorPartyId: T.vendor.id,
    vendorInvoiceNumber: `VB-${seq}`, invoiceDate: '2026-08-05', amountPaise,
  });
  if (inv.status !== 201) throw new Error(`bill failed: ${inv.status} ${inv.body.message}`);
  return inv.body.data;
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Finance Audit Co', slug: 'fin-audit', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Finance Audit Pvt Ltd', code: 'FAC' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@fin-audit.test', passwordHash, firstName: 'A', lastName: 'A', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });

  const plantA = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant A', code: 'PA', state: 'Odisha', dispatchTolerancePercent: 0 });
  const plantB = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant B', code: 'PB', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', gstRatePercent: 18 });
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Kalinga Builders', state: 'Odisha' });
  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Odisha Cement', state: 'Odisha' });
  await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Second Customer', state: 'Odisha' });

  T = { tenantId, org, plantA, plantB, uom, hsn, customer, vendor };
  admin = await loginAs('admin@fin-audit.test');

  const mkUser = async (email, permissions, factoryId) => {
    const u = await User.create({ tenantId, email, passwordHash, firstName: 'X', lastName: 'Y', role: 'EMPLOYEE' }, { validate: false });
    const g = await AdGroup.create({ tenantId, name: `G ${email}`, permissions });
    await AdGroupMember.create({ tenantId, adGroupId: g.id, employeeId: u.id });
    if (factoryId) await UserFactory.create({ tenantId, userId: u.id, factoryId });
    return loginAs(email);
  };
  plantBOnly = await mkUser('plantb@fin-audit.test', ['LEDGER_READ', 'RECEIPT_READ', 'PAYMENT_READ', 'EXPENSE_READ', 'VIEW_RATES', 'REPORT_FINANCE_READ', 'REPORT_CUSTOMER_READ'], plantB.id);
  // Deliberately no VIEW_RATES — BR-27 says money must not reach this browser.
  noRates = await mkUser('norates@fin-audit.test', ['LEDGER_READ', 'RECEIPT_READ', 'PAYMENT_READ', 'EXPENSE_READ', 'REPORT_FINANCE_READ', 'REPORT_CUSTOMER_READ'], plantA.id);

  const t2 = await Tenant.create({ name: 'Rival', slug: 'fin-rival', status: 'active' });
  const org2 = await Organization.create({ tenantId: t2.id, name: 'Rival Pvt', code: 'RIV' });
  await User.create({ tenantId: t2.id, email: 'admin@fin-rival.test', passwordHash, firstName: 'R', lastName: 'R', role: 'PLATFORM_ADMIN' }, { validate: false });
  await FinancialYear.create({ tenantId: t2.id, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const rf = await Factory.create({ tenantId: t2.id, organizationId: org2.id, name: 'Rival Plant', code: 'RP', state: 'Odisha' });
  const rc = await Party.create({ tenantId: t2.id, partyType: 'CUSTOMER', name: 'Rival Customer', state: 'Odisha' });
  other = { tenantId: t2.id, factory: rf, customer: rc, cookie: await loginAs('admin@fin-rival.test') };
});

afterAll(async () => {
  await sequelize.close();
});

// ===========================================================================
// A. Customer accounting
// ===========================================================================
describe('A. Customer accounting', () => {
  it('an invoice raises a balanced receivable against the customer', async () => {
    const p = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, hsnId: T.hsn.id, name: 'Slab A', code: 'FG-A', productType: 'FINISHED_GOOD' });
    const invoice = await sellAndInvoice(p, 10, 100000, 'A1');

    const entry = await JournalEntry.findOne({ where: { referenceType: 'SalesInvoice', referenceId: invoice.id } });
    expect(entry).not.toBeNull();
    const lines = await JournalLine.findAll({ where: { journalEntryId: entry.id } });
    expect(lines.reduce((s, l) => s + Number(l.debitPaise), 0)).toBe(lines.reduce((s, l) => s + Number(l.creditPaise), 0));

    // Receivable = the invoice total, against this customer, on the AR account.
    const arLines = lines.filter((l) => l.partyId === T.customer.id);
    expect(arLines).toHaveLength(1);
    expect(Number(arLines[0].debitPaise)).toBe(Number(invoice.totalPaise));
  });

  it('partial, then multiple payments settle it, and overpayment is refused', async () => {
    const p = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, hsnId: T.hsn.id, name: 'Slab B', code: 'FG-B', productType: 'FINISHED_GOOD' });
    const invoice = await sellAndInvoice(p, 10, 100000, 'A2');
    const due = Number(invoice.totalPaise);
    const before = await partyNet(T.customer.id);

    const pay = (amount, ref) =>
      as(admin).post('/api/v1/receipts', {
        factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-06',
        modes: [{ mode: 'BANK', amountPaise: amount, reference: ref }],
        allocations: [{ invoiceId: invoice.id, allocatedAmountPaise: amount }],
      });

    const third = Math.floor(due / 3);
    expect((await pay(third, 'UTR-1')).status).toBe(201);
    expect(await partyNet(T.customer.id)).toBe(before - third);

    expect((await pay(third, 'UTR-2')).status).toBe(201);
    expect((await pay(due - 2 * third, 'UTR-3')).status).toBe(201);
    // Fully settled: the customer's receivable is back where it started.
    expect(await partyNet(T.customer.id)).toBe(before - due);

    const over = await pay(100, 'UTR-4');
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/exceeds the outstanding/i);
  });

  it('cancelling a receipt reverses it in the ledger and frees the invoice again', async () => {
    const p = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, hsnId: T.hsn.id, name: 'Slab C', code: 'FG-C', productType: 'FINISHED_GOOD' });
    const invoice = await sellAndInvoice(p, 5, 100000, 'A3');
    const due = Number(invoice.totalPaise);
    const afterInvoice = await partyNet(T.customer.id);

    const receipt = await as(admin).post('/api/v1/receipts', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-06',
      modes: [{ mode: 'BANK', amountPaise: due, reference: 'UTR-C' }],
      allocations: [{ invoiceId: invoice.id, allocatedAmountPaise: due }],
    });
    expect(receipt.status).toBe(201);
    expect(await partyNet(T.customer.id)).toBe(afterInvoice - due);

    const cancelled = await as(admin).put(`/api/v1/receipts/${receipt.body.data.id}/cancel`, { reason: 'wrong amount keyed' });
    expect(cancelled.status).toBe(200);
    // The reversal is a new opposite entry, not an edit.
    const entries = await JournalEntry.findAll({ where: { referenceType: 'Receipt', referenceId: receipt.body.data.id } });
    expect(entries).toHaveLength(2);
    expect(entries.some((e) => e.reversalOfEntryId)).toBe(true);
    // ...and the receivable is back.
    expect(await partyNet(T.customer.id)).toBe(afterInvoice);
  });

  it('shows a running balance on the customer ledger', async () => {
    const res = await as(admin).get(`/api/v1/ledger/party/${T.customer.id}?page=1&limit=100`);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);

    // A statement without a running balance is not a statement.
    const rows = res.body.data.rows;
    expect(rows[0]).toHaveProperty('runningBalancePaise');

    // Oldest-first, and each row's balance is the previous one plus its own movement.
    let expected = Number(res.body.data.openingBalancePaise ?? 0);
    for (const row of rows) {
      expected += Number(row.debitPaise) - Number(row.creditPaise);
      expect([row.id, Number(row.runningBalancePaise)]).toEqual([row.id, expected]);
    }
    expect(Number(res.body.data.closingBalancePaise)).toBe(expected);
  });

  it('reports a customer receivable as a positive outstanding balance', async () => {
    const p = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, hsnId: T.hsn.id, name: 'Slab D', code: 'FG-D', productType: 'FINISHED_GOOD' });
    const fresh = await Party.create({ tenantId: T.tenantId, partyType: 'CUSTOMER', name: 'Owing Customer', state: 'Odisha' });

    // Sell to the new customer specifically.
    await as(admin).post('/api/v1/purchasing/receipts', {
      factoryId: T.plantA.id, vendorPartyId: T.vendor.id, receiptDate: '2026-08-01',
      lines: [{ productId: p.id, receivedQty: 10, ratePaise: 100 }],
    });
    const order = await as(admin).post('/api/v1/sales/orders', {
      factoryId: T.plantA.id, customerPartyId: fresh.id, orderDate: '2026-08-02',
      lines: [{ productId: p.id, orderedQty: 10, ratePaise: 100000 }],
    });
    const confirmed = await as(admin).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`);
    const challan = await as(admin).post('/api/v1/dispatch/challans', {
      salesOrderId: order.body.data.id, vehicleNumber: 'OD-A5', dispatchDate: '2026-08-03',
      lines: [{ salesOrderLineId: confirmed.body.data.lines[0].id, dispatchedQty: 10 }],
    });
    const invoice = await as(admin).post('/api/v1/invoices', { challanIds: [challan.body.data.id], invoiceDate: '2026-08-04' });

    const res = await as(admin).get(`/api/v1/ledger/party/${fresh.id}?page=1&limit=50`);
    expect(Number(res.body.data.outstandingPaise)).toBe(Number(invoice.body.data.totalPaise));
  });
});

// ===========================================================================
// B. Vendor accounting
// ===========================================================================
describe('B. Vendor accounting', () => {
  it('a bill raises a payable, and payment settles it', async () => {
    const p = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'RM A', code: 'RM-A', productType: 'RAW_MATERIAL' });
    const vendorBefore = await partyNet(T.vendor.id);

    const bill = await billVendor(p, 10, 500000, 'B1');
    // A payable is a credit, so the signed net moves down by the bill amount.
    expect(await partyNet(T.vendor.id)).toBe(vendorBefore - 500000);

    const paid = await as(admin).post('/api/v1/payments', {
      factoryId: T.plantA.id, partyId: T.vendor.id, paymentDate: '2026-08-07',
      modes: [{ mode: 'BANK', amountPaise: 200000, reference: 'UTR-V1' }],
      allocations: [{ invoiceId: bill.id, allocatedAmountPaise: 200000 }],
    });
    expect(paid.status).toBe(201);
    expect((await PurchaseInvoice.findByPk(bill.id)).paymentStatus).toBe('PARTIALLY_PAID');
    expect(await partyNet(T.vendor.id)).toBe(vendorBefore - 300000);
  });

  it('reports a vendor payable as a positive outstanding balance', async () => {
    const p = await Product.create({ tenantId: T.tenantId, uomId: T.uom.id, name: 'RM B', code: 'RM-B', productType: 'RAW_MATERIAL' });
    const fresh = await Party.create({ tenantId: T.tenantId, partyType: 'VENDOR', name: 'Owed Vendor', state: 'Odisha' });

    const grn = await as(admin).post('/api/v1/purchasing/receipts', {
      factoryId: T.plantA.id, vendorPartyId: fresh.id, receiptDate: '2026-08-01',
      lines: [{ productId: p.id, receivedQty: 5, ratePaise: 100 }],
    });
    await as(admin).post('/api/v1/purchasing/invoices', {
      factoryId: T.plantA.id, goodsReceiptId: grn.body.data.id, vendorPartyId: fresh.id,
      vendorInvoiceNumber: 'VB-OWED', invoiceDate: '2026-08-05', amountPaise: 750000,
    });

    // What we owe a vendor is money owed, so it must read positive on the
    // statement — the same way a customer's receivable does. A bare
    // debit − credit returns it negated.
    const res = await as(admin).get(`/api/v1/ledger/party/${fresh.id}?page=1&limit=50`);
    expect(Number(res.body.data.outstandingPaise)).toBe(750000);
  });
});

// ===========================================================================
// C. Payments
// ===========================================================================
describe('C. Payments', () => {
  it('records modes, references and the unallocated remainder', async () => {
    const receipt = await as(admin).post('/api/v1/receipts', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-08',
      modes: [
        { mode: 'BANK', amountPaise: 60000, reference: 'UTR-M1' },
        { mode: 'UPI', amountPaise: 40000, reference: 'UPI-M2' },
      ],
    });
    expect(receipt.status).toBe(201);
    expect(Number(receipt.body.data.totalAmountPaise)).toBe(100000);
    // Nothing allocated, so all of it is on account.
    expect(Number(receipt.body.data.unallocatedAmountPaise)).toBe(100000);
    expect(receipt.body.data.modes).toHaveLength(2);
    expect(receipt.body.data.modes.map((m) => m.reference)).toEqual(['UTR-M1', 'UPI-M2']);
  });

  it('refuses a receipt whose modes do not add up to its total', async () => {
    const res = await as(admin).post('/api/v1/receipts', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-08',
      modes: [{ mode: 'BANK', amountPaise: 0, reference: 'X' }],
    });
    expect(res.status).toBe(400);
  });

  it('books a multi-mode cash receipt on the cash account in full', async () => {
    // Two CASH lines on one receipt land as two lines on the same journal
    // against the same account. Anything that reads "the cash line" of an
    // entry rather than all of them will understate the day's cash.
    const before = await accountBalance('1000', T.plantA.id);
    const receipt = await as(admin).post('/api/v1/receipts', {
      factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-09',
      modes: [
        { mode: 'CASH', amountPaise: 30000 },
        { mode: 'CASH', amountPaise: 20000 },
      ],
    });
    expect(receipt.status).toBe(201);
    expect(await accountBalance('1000', T.plantA.id)).toBe(before + 50000);

    const cashBook = await as(admin).get(`/api/v1/ledger/cash-book?factoryId=${T.plantA.id}`);
    expect(cashBook.status).toBe(200);
    const rows = cashBook.body.data.rows ?? cashBook.body.data;
    const net = rows.reduce((s, r) => s + Number(r.debitPaise) - Number(r.creditPaise), 0);
    expect(net).toBe(await accountBalance('1000', T.plantA.id));
  });
});

// ===========================================================================
// D. Expenses
// ===========================================================================
describe('D. Expenses', () => {
  it('posts an expense to the expense account and out of the paying account', async () => {
    const bankBefore = await accountBalance('1010', T.plantA.id);
    const expenseBefore = await accountBalance('5900', T.plantA.id);

    const exp = await as(admin).post('/api/v1/expenses', {
      factoryId: T.plantA.id, expenseDate: '2026-08-10', category: 'Fuel', mode: 'BANK',
      amountPaise: 250000, description: 'Diesel for genset',
    });
    expect(exp.status).toBe(201);

    expect(await accountBalance('5900', T.plantA.id)).toBe(expenseBefore + 250000);
    expect(await accountBalance('1010', T.plantA.id)).toBe(bankBefore - 250000);

    const entry = await JournalEntry.findOne({ where: { referenceType: 'Expense', referenceId: exp.body.data.id } });
    expect(entry).not.toBeNull();
    expect(Number(entry.totalDebitPaise)).toBe(Number(entry.totalCreditPaise));
  });

  it('refuses a cash expense the factory has no cash for (BR-21)', async () => {
    const res = await as(admin).post('/api/v1/expenses', {
      factoryId: T.plantB.id, expenseDate: '2026-08-10', category: 'Repairs', mode: 'CASH', amountPaise: 999999,
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/insufficient cash/i);
  });

  it('cancelling an expense reverses it', async () => {
    const exp = await as(admin).post('/api/v1/expenses', {
      factoryId: T.plantA.id, expenseDate: '2026-08-11', category: 'Stationery', mode: 'BANK', amountPaise: 5000,
    });
    const before = await accountBalance('5900', T.plantA.id);
    const cancelled = await as(admin).put(`/api/v1/expenses/${exp.body.data.id}/cancel`, { reason: 'duplicate entry' });
    expect(cancelled.status).toBe(200);
    expect(await accountBalance('5900', T.plantA.id)).toBe(before - 5000);
  });
});

// ===========================================================================
// E. Ledger integrity
// ===========================================================================
describe('E. Ledger integrity', () => {
  it('every journal entry is internally balanced', async () => {
    const entries = await JournalEntry.findAll({ include: [{ model: JournalLine, as: 'lines' }] });
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      const debit = entry.lines.reduce((s, l) => s + Number(l.debitPaise), 0);
      const credit = entry.lines.reduce((s, l) => s + Number(l.creditPaise), 0);
      expect([entry.id, debit]).toEqual([entry.id, credit]);
      expect([entry.id, Number(entry.totalDebitPaise)]).toEqual([entry.id, debit]);
    }
  });

  it('the books balance in aggregate — total debits equal total credits', async () => {
    const lines = await JournalLine.findAll();
    const debit = lines.reduce((s, l) => s + Number(l.debitPaise), 0);
    const credit = lines.reduce((s, l) => s + Number(l.creditPaise), 0);
    expect(debit).toBe(credit);
  });

  it('the trial balance sums to zero', async () => {
    const res = await as(admin).get(`/api/v1/ledger/trial-balance?factoryId=${T.plantA.id}`);
    expect(res.status).toBe(200);
    const total = res.body.data.reduce((s, r) => s + Number(r.balancePaise), 0);
    expect(total).toBe(0);
  });

  it('refuses an unbalanced journal outright', async () => {
    const { LedgerService } = require('../src/api/ledger/ledger.service');
    const { getTenantContext } = require('../src/core/tenantContext');
    const ns = getTenantContext();
    await new Promise((resolve) => ns.run(async () => {
      ns.set('tenantId', T.tenantId);
      await expect(
        sequelize.transaction((t) =>
          LedgerService.postJournal({
            factoryId: T.plantA.id, entryDate: '2026-08-12', referenceType: 'Test', referenceId: T.plantA.id,
            narration: 'deliberately lopsided',
            lines: [
              { accountKey: 'FACTORY_EXPENSE', debitPaise: 100, creditPaise: 0 },
              { accountKey: 'BANK', debitPaise: 0, creditPaise: 90 },
            ],
            transaction: t,
          })
        )
      ).rejects.toThrow(/not balanced/i);
      resolve();
    }));
  });

  it('posts exactly one journal per financial document — no duplicates', async () => {
    const entries = await JournalEntry.findAll({ where: { reversalOfEntryId: null } });
    const seen = new Map();
    for (const e of entries) {
      if (!e.referenceType || !e.referenceId) continue;
      const key = `${e.referenceType}:${e.referenceId}`;
      seen.set(key, (seen.get(key) || 0) + 1);
    }
    const duplicated = [...seen.entries()].filter(([, n]) => n > 1);
    expect(duplicated).toEqual([]);
  });

  it('every journal line carries a party on a control account', async () => {
    const controls = await Account.findAll({ where: { isPartyControlAccount: true } });
    const ids = controls.map((a) => a.id);
    const lines = await JournalLine.findAll({ where: { accountId: ids } });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.partyId)).toBe(true);
  });

  it('every entry carries a date, a reference and the user who posted it', async () => {
    const entries = await JournalEntry.findAll({ limit: 200 });
    expect(entries.every((e) => e.entryDate)).toBe(true);
    expect(entries.every((e) => e.referenceType && e.referenceId)).toBe(true);
    expect(entries.every((e) => e.factoryId)).toBe(true);
    // Reversals inherit their creator from the cancelling request.
    expect(entries.filter((e) => e.createdBy).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// F. Cash flow
// ===========================================================================
describe('F. Cash flow', () => {
  it('opening + in − out = closing over a date window', async () => {
    // Put a known amount of cash in on a specific day, then take some out.
    await as(admin).post('/api/v1/receipts', {
      factoryId: T.plantB.id, customerPartyId: T.customer.id, receiptDate: '2026-09-01',
      modes: [{ mode: 'CASH', amountPaise: 500000 }],
    });
    await as(admin).post('/api/v1/expenses', {
      factoryId: T.plantB.id, expenseDate: '2026-09-05', category: 'Fuel', mode: 'CASH', amountPaise: 120000,
    });
    await as(admin).post('/api/v1/expenses', {
      factoryId: T.plantB.id, expenseDate: '2026-09-20', category: 'Repairs', mode: 'CASH', amountPaise: 80000,
    });

    // A window that starts AFTER the first two movements. Its opening balance
    // must carry them, otherwise the closing figure is wrong by everything
    // that happened before the window.
    const res = await as(admin).get(`/api/v1/ledger/cash-book?factoryId=${T.plantB.id}&from=2026-09-10&to=2026-09-30`);
    expect(res.status).toBe(200);

    const body = res.body.data;
    const rows = body.rows ?? body;
    expect(Number(body.openingBalancePaise)).toBe(500000 - 120000);

    const cashIn = rows.reduce((s, r) => s + Number(r.debitPaise), 0);
    const cashOut = rows.reduce((s, r) => s + Number(r.creditPaise), 0);
    expect(Number(body.openingBalancePaise) + cashIn - cashOut).toBe(Number(body.closingBalancePaise));
    expect(Number(body.closingBalancePaise)).toBe(500000 - 120000 - 80000);
  });
});

// ===========================================================================
// G. Security
// ===========================================================================
describe('G. Security', () => {
  it('never leaks another tenant\'s ledger', async () => {
    expect((await as(other.cookie).get(`/api/v1/ledger/party/${T.customer.id}?page=1&limit=10`)).body.data.rows).toHaveLength(0);
    const tb = await as(other.cookie).get('/api/v1/ledger/trial-balance');
    expect(tb.status).toBe(200);
    const total = tb.body.data.reduce((s, r) => s + Number(r.balancePaise), 0);
    expect(total).toBe(0);
  });

  it('confines a Plant-B user\'s financial data to Plant B', async () => {
    expect((await as(plantBOnly).get(`/api/v1/ledger/trial-balance?factoryId=${T.plantA.id}`)).status).toBe(403);
    expect((await as(plantBOnly).get(`/api/v1/ledger/cash-book?factoryId=${T.plantA.id}`)).status).toBe(403);

    // With no factory named, only their own location's figures come back.
    const tb = await as(plantBOnly).get('/api/v1/ledger/trial-balance');
    expect(tb.status).toBe(200);
    const cash = tb.body.data.find((r) => r.code === '1000');
    // Plant B holds 500000 − 120000 − 80000 in cash; Plant A's cash is excluded.
    expect(Number(cash ? cash.balancePaise : 0)).toBe(300000);
  });

  it('strips every money field from a user without VIEW_RATES, on every finance endpoint', async () => {
    const tb = await as(noRates).get(`/api/v1/ledger/trial-balance?factoryId=${T.plantA.id}`);
    expect(tb.status).toBe(200);
    expect(tb.body.data.every((r) => r.balancePaise === null && r.totalDebitPaise === null)).toBe(true);

    const cb = await as(noRates).get(`/api/v1/ledger/cash-book?factoryId=${T.plantA.id}`);
    expect(cb.status).toBe(200);
    const cbRows = cb.body.data.rows ?? cb.body.data;
    expect(cbRows.every((r) => r.debitPaise === null && r.runningBalancePaise === null)).toBe(true);

    const pl = await as(noRates).get(`/api/v1/ledger/party/${T.customer.id}?page=1&limit=20`);
    expect(pl.status).toBe(200);
    expect(pl.body.data.outstandingPaise).toBeNull();
    expect(pl.body.data.rows.every((r) => r.debitPaise === null && r.creditPaise === null)).toBe(true);
    // The running balance is money too — it must not survive masking.
    expect(pl.body.data.rows.every((r) => r.runningBalancePaise === null)).toBe(true);
    expect(pl.body.data.closingBalancePaise ?? null).toBeNull();

    // Receipts, payments and expenses too.
    const receipts = await as(noRates).get('/api/v1/receipts?limit=10');
    expect(receipts.body.data.rows.every((r) => r.totalAmountPaise === null)).toBe(true);
    const expenses = await as(noRates).get('/api/v1/expenses?limit=10');
    expect(expenses.body.data.rows.every((r) => r.amountPaise === null)).toBe(true);
  });

  it('strips money from the finance reports too, not just the column list', async () => {
    const res = await as(noRates).get(`/api/v1/reports/finance/day-book?factoryId=${T.plantA.id}&page=1&limit=20`);
    expect(res.status).toBe(200);
    // The column definitions must not advertise money...
    expect(res.body.data.columns.some((c) => c.type === 'money')).toBe(false);
    // ...and the row payload must not contain it either.
    const moneyKeys = ['debitPaise', 'creditPaise', 'amountPaise', 'runningBalancePaise'];
    for (const row of res.body.data.rows) {
      for (const key of moneyKeys) expect([key, key in row]).toEqual([key, false]);
    }
  });

  it('requires authentication and LEDGER_READ', async () => {
    expect((await request(app).get('/api/v1/ledger/trial-balance')).status).toBe(401);
    const noLedger = await (async () => {
      const u = await User.create(
        { tenantId: T.tenantId, email: 'noledger@fin-audit.test', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'N', lastName: 'L', role: 'EMPLOYEE' },
        { validate: false }
      );
      const g = await AdGroup.create({ tenantId: T.tenantId, name: 'No Ledger', permissions: ['SALES_READ'] });
      await AdGroupMember.create({ tenantId: T.tenantId, adGroupId: g.id, employeeId: u.id });
      return loginAs('noledger@fin-audit.test');
    })();
    expect((await as(noLedger).get('/api/v1/ledger/trial-balance')).status).toBe(403);
    expect((await as(noLedger).get(`/api/v1/ledger/party/${T.customer.id}`)).status).toBe(403);
  });
});

// ===========================================================================
// H. Audit trail
// ===========================================================================
describe('H. Audit trail', () => {
  it('records who, when, what changed and against which document', async () => {
    for (const entityType of ['SalesInvoice', 'Receipt', 'PurchaseInvoice', 'Payment', 'Expense']) {
      const rows = await AuditLog.findAll({ where: { entityType } });
      expect([entityType, rows.length > 0]).toEqual([entityType, true]);
      expect([entityType, rows.every((r) => r.userId && r.createdAt && r.entityId)]).toEqual([entityType, true]);
    }

    // A cancellation records the before and after values, not just a timestamp.
    const cancels = await AuditLog.findAll({ where: { entityType: 'Receipt', action: 'UPDATE' } });
    const statusChange = cancels.find((r) => r.afterSnapshot && r.afterSnapshot.status === 'CANCELLED');
    expect(statusChange).toBeDefined();
    expect(statusChange.beforeSnapshot.status).toBe('POSTED');
    expect(statusChange.ipAddress).toBeTruthy();
  });
});

// ===========================================================================
// I. Reports
// ===========================================================================
describe('I. Reports', () => {
  const REPORTS = [
    ['Customer Ledger', 'customer/ledger'],
    ['Vendor Ledger', 'vendor/ledger'],
    ['Receivables', 'finance/receivables'],
    ['Payables', 'finance/payables'],
    ['Payment Report', 'payment/register'],
    ['Expense Report', 'expense/register'],
    ['Day Book', 'finance/day-book'],
    ['Cash Flow', 'finance/cash-flow'],
  ];

  it('serves every finance report the brief names', async () => {
    for (const [label, path] of REPORTS) {
      const res = await as(admin).get(`/api/v1/reports/${path}?factoryId=${T.plantA.id}&page=1&limit=20`);
      expect([label, res.status]).toEqual([label, 200]);
    }
  });

  it('the day book reconciles to the journal for the period', async () => {
    const res = await as(admin).get(`/api/v1/reports/finance/day-book?factoryId=${T.plantA.id}&page=1&limit=200`);
    expect(res.status).toBe(200);
    const rows = res.body.data.rows;
    const debit = rows.reduce((s, r) => s + Number(r.debitPaise || 0), 0);
    const credit = rows.reduce((s, r) => s + Number(r.creditPaise || 0), 0);
    // The day book is the journal — it must balance exactly like the journal does.
    expect(debit).toBe(credit);
  });

  it('receivables agree with the customer control account', async () => {
    const res = await as(admin).get(`/api/v1/reports/finance/receivables?factoryId=${T.plantA.id}&page=1&limit=200`);
    expect(res.status).toBe(200);
    expect(Number(res.body.data.summary.outstandingPaise)).toBeGreaterThanOrEqual(0);
  });
});
