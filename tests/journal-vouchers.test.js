const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, Factory, FinancialYear, Party } = require('../src/models/index');
const { JournalEntry } = require('../src/api/ledger/journalEntry.model');
const { JournalLine } = require('../src/api/ledger/journalLine.model');

/**
 * Chart of accounts, several bank/cash accounts, and journal/contra vouchers.
 *
 * The properties that matter:
 *  - existing flows are untouched — a receipt with no accountId still lands in
 *    the system Bank Account;
 *  - a named bank account receives exactly the money routed to it, and its
 *    cash book reads like a bank statement;
 *  - a voucher cannot do what would quietly break another module (touch a
 *    party's receivable/payable, drive cash negative, post unbalanced);
 *  - cancelling reverses rather than edits.
 */

const PASSWORD = 'password123';
let cookie;
let factory;
let tenantId;
let customer;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const api = {
  get: (url) => request(app).get(url).set('Cookie', cookie),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookie).send(body),
};

const balanceOf = async (accountId) => {
  const tb = await api.get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`);
  const row = tb.body.data.find((r) => r.accountId === accountId);
  return row ? row.balancePaise : 0;
};

const accountByCode = async (code) => {
  const res = await api.get('/api/v1/ledger/accounts?includeInactive=true');
  return res.body.data.find((a) => a.code === code);
};

let hdfc;
let sbi;
let pettyCash;
let rent;
let loan;

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Voucher Precast', slug: 'voucher-precast', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Voucher Precast Pvt Ltd', code: 'VPL' });
  await User.create(
    { tenantId, email: 'admin@voucher-test.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Voucher Factory', code: 'VCH', state: 'Odisha' });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Voucher Buyer' });

  cookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@voucher-test.co', password: PASSWORD }),
    'accessToken'
  );
});

afterAll(async () => {
  await sequelize.close();
});

describe('Chart of accounts', () => {
  it('lists the statement groups', async () => {
    const res = await api.get('/api/v1/ledger/account-groups');
    expect(res.status).toBe(200);
    const keys = res.body.data.map((g) => g.key);
    expect(keys).toEqual(expect.arrayContaining(['FIXED_ASSET', 'CURRENT_ASSET', 'DIRECT_EXPENSE', 'INDIRECT_EXPENSE', 'CAPITAL']));
  });

  it('creates a bank account with its opening balance against Opening Balance Equity', async () => {
    const res = await api.post('/api/v1/ledger/accounts', {
      code: '1011', name: 'HDFC Current A/c', accountGroup: 'CURRENT_ASSET', subType: 'BANK',
      bankName: 'HDFC Bank', accountNumber: '50200012345678', ifsc: 'hdfc0001234', branch: 'Bhubaneswar',
      openingBalance: { factoryId: factory.id, asOfDate: '2026-04-01', amountPaise: 50000000 },
    });
    expect(res.status).toBe(201);
    hdfc = res.body.data;
    expect(hdfc.type).toBe('ASSET');
    expect(hdfc.subType).toBe('BANK');
    expect(hdfc.ifsc).toBe('HDFC0001234');
    expect(hdfc.isSystem).toBe(false);

    expect(await balanceOf(hdfc.id)).toBe(50000000);
    const obe = await accountByCode('3000');
    expect(await balanceOf(obe.id)).toBe(-50000000);
  });

  it('creates a second bank, a petty-cash box, an expense head and a loan', async () => {
    sbi = (await api.post('/api/v1/ledger/accounts', { code: '1012', name: 'SBI Cash Credit', accountGroup: 'CURRENT_LIABILITY', subType: 'BANK' })).body.data;
    pettyCash = (await api.post('/api/v1/ledger/accounts', { code: '1001', name: 'Petty Cash — Yard', accountGroup: 'CURRENT_ASSET', subType: 'CASH' })).body.data;
    rent = (await api.post('/api/v1/ledger/accounts', { code: '5910', name: 'Rent', accountGroup: 'INDIRECT_EXPENSE' })).body.data;
    loan = (await api.post('/api/v1/ledger/accounts', { code: '2500', name: 'Loan from Director', accountGroup: 'LONG_TERM_LIABILITY' })).body.data;

    expect(sbi.type).toBe('LIABILITY');
    expect(pettyCash.subType).toBe('CASH');
    expect(rent.type).toBe('EXPENSE');
    expect(loan.type).toBe('LIABILITY');

    const money = await api.get('/api/v1/ledger/accounts?moneyOnly=true');
    const codes = money.body.data.map((a) => a.code);
    expect(codes).toEqual(expect.arrayContaining(['1011', '1012', '1001']));
    expect(codes).not.toContain('5910');
  });

  it('refuses a code a posting service owns', async () => {
    const res = await api.post('/api/v1/ledger/accounts', { code: '1010', name: 'My Bank', accountGroup: 'CURRENT_ASSET', subType: 'BANK' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/reserved/);
  });

  it('refuses a duplicate code', async () => {
    const res = await api.post('/api/v1/ledger/accounts', { code: '1011', name: 'Another', accountGroup: 'CURRENT_ASSET' });
    expect(res.status).toBe(409);
  });

  it('refuses a cash account that is a liability', async () => {
    const res = await api.post('/api/v1/ledger/accounts', { code: '2999', name: 'Odd Cash', accountGroup: 'CURRENT_LIABILITY', subType: 'CASH' });
    expect(res.status).toBe(400);
  });

  it('refuses an unknown group', async () => {
    const res = await api.post('/api/v1/ledger/accounts', { code: '7000', name: 'Odd', accountGroup: 'MISC' });
    expect(res.status).toBe(400);
  });

});

describe('Contra vouchers', () => {
  let contra;

  it('moves money from a bank into a cash box', async () => {
    const res = await api.post('/api/v1/ledger/vouchers', {
      factoryId: factory.id, voucherType: 'CONTRA', voucherDate: '2026-05-02', narration: 'Cash withdrawn for yard wages',
      lines: [
        { accountId: pettyCash.id, debitPaise: 2000000 },
        { accountId: hdfc.id, creditPaise: 2000000 },
      ],
    });
    expect(res.status).toBe(201);
    contra = res.body.data;
    expect(contra.voucherNumber).toMatch(/^CV\//);
    expect(contra.totalPaise).toBe(2000000);
    expect(contra.lines).toHaveLength(2);

    expect(await balanceOf(pettyCash.id)).toBe(2000000);
    expect(await balanceOf(hdfc.id)).toBe(48000000);
  });

  it('shows up in the cash book of the named account with the right opening balance', async () => {
    const res = await api.get(`/api/v1/ledger/cash-book?factoryId=${factory.id}&accountId=${hdfc.id}&from=2026-05-01&to=2026-05-31`);
    expect(res.status).toBe(200);
    expect(res.body.data.accountName).toBe('HDFC Current A/c');
    expect(res.body.data.openingBalancePaise).toBe(50000000);
    expect(res.body.data.totalOutPaise).toBe(2000000);
    expect(res.body.data.closingBalancePaise).toBe(48000000);
  });

  it('refuses an account that is not cash or bank', async () => {
    const res = await api.post('/api/v1/ledger/vouchers', {
      factoryId: factory.id, voucherType: 'CONTRA', voucherDate: '2026-05-02', narration: 'Wrong',
      lines: [{ accountId: rent.id, debitPaise: 100 }, { accountId: hdfc.id, creditPaise: 100 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cash and bank accounts only/);
  });

  it('refuses to take a cash box below zero', async () => {
    const res = await api.post('/api/v1/ledger/vouchers', {
      factoryId: factory.id, voucherType: 'CONTRA', voucherDate: '2026-05-03', narration: 'Deposit more than the box holds',
      lines: [{ accountId: hdfc.id, debitPaise: 9000000 }, { accountId: pettyCash.id, creditPaise: 9000000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Insufficient cash in Petty Cash/);
    expect(await balanceOf(pettyCash.id)).toBe(2000000);
  });
});

describe('Journal vouchers', () => {
  let rentVoucher;

  it('posts rent paid from a bank', async () => {
    const res = await api.post('/api/v1/ledger/vouchers', {
      factoryId: factory.id, voucherType: 'JOURNAL', voucherDate: '2026-05-05', narration: 'May rent — yard',
      lines: [{ accountId: rent.id, debitPaise: 3500000 }, { accountId: hdfc.id, creditPaise: 3500000 }],
    });
    expect(res.status).toBe(201);
    rentVoucher = res.body.data;
    expect(rentVoucher.voucherNumber).toMatch(/^JV\//);
    expect(await balanceOf(rent.id)).toBe(3500000);
    expect(await balanceOf(hdfc.id)).toBe(44500000);
  });

  it('posts a loan received into a bank', async () => {
    const res = await api.post('/api/v1/ledger/vouchers', {
      factoryId: factory.id, voucherType: 'JOURNAL', voucherDate: '2026-05-06', narration: 'Loan from director',
      lines: [{ accountId: hdfc.id, debitPaise: 100000000 }, { accountId: loan.id, creditPaise: 100000000 }],
    });
    expect(res.status).toBe(201);
    expect(await balanceOf(loan.id)).toBe(-100000000);
  });

  it('refuses an unbalanced voucher and posts nothing', async () => {
    const before = await JournalEntry.count();
    const res = await api.post('/api/v1/ledger/vouchers', {
      factoryId: factory.id, voucherType: 'JOURNAL', voucherDate: '2026-05-07', narration: 'Off by a rupee',
      lines: [{ accountId: rent.id, debitPaise: 100100 }, { accountId: hdfc.id, creditPaise: 100000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not balanced/);
    expect(await JournalEntry.count()).toBe(before);
  });

  it('refuses a line with both a debit and a credit', async () => {
    const res = await api.post('/api/v1/ledger/vouchers', {
      factoryId: factory.id, voucherType: 'JOURNAL', voucherDate: '2026-05-07', narration: 'Both sides',
      lines: [{ accountId: rent.id, debitPaise: 500, creditPaise: 500 }, { accountId: hdfc.id, debitPaise: 0, creditPaise: 0 }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses the receivable account, pointing to the documents that keep invoices in step', async () => {
    const ar = await accountByCode('1100');
    // AR only exists once something has posted to it; create it via a receipt.
    await api.post('/api/v1/receipts', {
      factoryId: factory.id, customerPartyId: customer.id, receiptDate: '2026-05-08',
      modes: [{ mode: 'CASH', amountPaise: 1000 }],
    });
    const receivable = ar || (await accountByCode('1100'));
    const res = await api.post('/api/v1/ledger/vouchers', {
      factoryId: factory.id, voucherType: 'JOURNAL', voucherDate: '2026-05-08', narration: 'Write off',
      lines: [{ accountId: rent.id, debitPaise: 1000 }, { accountId: receivable.id, creditPaise: 1000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/credit note/);
  });

  it('cancels by reversing, restoring every balance', async () => {
    const res = await api.put(`/api/v1/ledger/vouchers/${rentVoucher.id}/cancel`, { reason: 'Posted to the wrong month' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('CANCELLED');
    expect(await balanceOf(rent.id)).toBe(0);

    const entries = await JournalEntry.findAll({ where: { referenceType: 'JournalVoucher', referenceId: rentVoucher.id } });
    expect(entries).toHaveLength(2);
    expect(entries.filter((e) => e.reversalOfEntryId)).toHaveLength(1);
  });

  it('refuses to cancel twice', async () => {
    const res = await api.put(`/api/v1/ledger/vouchers/${rentVoucher.id}/cancel`, { reason: 'Again' });
    expect(res.status).toBe(400);
  });

  it('lists vouchers with filters', async () => {
    const res = await api.get('/api/v1/ledger/vouchers?page=1&limit=20&voucherType=JOURNAL');
    expect(res.status).toBe(200);
    expect(res.body.data.rows.every((v) => v.voucherType === 'JOURNAL')).toBe(true);
    expect(res.body.data.rows.length).toBeGreaterThanOrEqual(2);
  });
});

describe('Naming a bank on receipts, payments and expenses', () => {
  it('still posts a receipt with no account to the system Bank Account', async () => {
    const res = await api.post('/api/v1/receipts', {
      factoryId: factory.id, customerPartyId: customer.id, receiptDate: '2026-05-10',
      modes: [{ mode: 'UPI', amountPaise: 118000 }],
    });
    expect(res.status).toBe(201);
    const bank = await accountByCode('1010');
    const line = await JournalLine.findOne({ where: { accountId: bank.id, debitPaise: 118000 } });
    expect(line).toBeTruthy();
  });

  it('keeps a system account structurally fixed but lets its bank details be filled in', async () => {
    // Exists now: the receipt above created it on first use.
    const bank = await accountByCode('1010');
    const rename = await api.put(`/api/v1/ledger/accounts/${bank.id}`, { name: 'Renamed' });
    expect(rename.status).toBe(400);
    const details = await api.put(`/api/v1/ledger/accounts/${bank.id}`, { bankName: 'Axis Bank', accountNumber: '9120' });
    expect(details.status).toBe(200);
    expect(details.body.data.bankName).toBe('Axis Bank');
  });

  it('posts a receipt into the bank the customer paid', async () => {
    const before = await balanceOf(hdfc.id);
    const res = await api.post('/api/v1/receipts', {
      factoryId: factory.id, customerPartyId: customer.id, receiptDate: '2026-05-11',
      modes: [{ mode: 'BANK', amountPaise: 236000, reference: 'UTR123', accountId: hdfc.id }],
    });
    expect(res.status).toBe(201);
    expect(await balanceOf(hdfc.id)).toBe(before + 236000);
  });

  it('refuses cash money routed to a bank account', async () => {
    const res = await api.post('/api/v1/receipts', {
      factoryId: factory.id, customerPartyId: customer.id, receiptDate: '2026-05-11',
      modes: [{ mode: 'CASH', amountPaise: 1000, accountId: hdfc.id }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/not a cash account/);
  });

  it('pays an expense out of the petty-cash box', async () => {
    const res = await api.post('/api/v1/expenses', {
      factoryId: factory.id, expenseDate: '2026-05-12', category: 'Diesel', mode: 'CASH', amountPaise: 150000, accountId: pettyCash.id,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.accountId).toBe(pettyCash.id);
    expect(await balanceOf(pettyCash.id)).toBe(2000000 - 150000);
  });

  it('books bounce charges against the bank the cheque was deposited in', async () => {
    const receipt = await api.post('/api/v1/receipts', {
      factoryId: factory.id, customerPartyId: customer.id, receiptDate: '2026-05-13',
      modes: [{ mode: 'CHEQUE', amountPaise: 500000, chequeNumber: 'VCH-1', chequeDate: '2026-05-13', bankName: 'ICICI', accountId: hdfc.id }],
    });
    expect(receipt.status).toBe(201);
    const cheques = await api.get('/api/v1/cheques?page=1&limit=50');
    const cheque = cheques.body.data.rows.find((c) => c.chequeNumber === 'VCH-1');
    expect(cheque.accountId).toBe(hdfc.id);

    const afterDeposit = await balanceOf(hdfc.id);
    await api.put(`/api/v1/cheques/${cheque.id}/present`, {});
    const bounced = await api.put(`/api/v1/cheques/${cheque.id}/bounce`, { reason: 'Funds insufficient', bankChargesPaise: 35400 });
    expect(bounced.status).toBe(200);
    // The deposit is reversed and the charge comes out of the same bank.
    expect(await balanceOf(hdfc.id)).toBe(afterDeposit - 500000 - 35400);
  });
});

describe('Deactivating an account', () => {
  it('refuses while the account still carries a balance', async () => {
    const res = await api.put(`/api/v1/ledger/accounts/${pettyCash.id}`, { isActive: false });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/still carries a balance/);
  });

  it('allows it at zero, hides it from pickers, and blocks new vouchers on it', async () => {
    const empty = (await api.post('/api/v1/ledger/accounts', { code: '1013', name: 'Old Axis A/c', accountGroup: 'CURRENT_ASSET', subType: 'BANK' })).body.data;
    const res = await api.put(`/api/v1/ledger/accounts/${empty.id}`, { isActive: false });
    expect(res.status).toBe(200);
    expect(res.body.data.isActive).toBe(false);

    const money = await api.get('/api/v1/ledger/accounts?moneyOnly=true');
    expect(money.body.data.map((a) => a.id)).not.toContain(empty.id);

    const voucher = await api.post('/api/v1/ledger/vouchers', {
      factoryId: factory.id, voucherType: 'CONTRA', voucherDate: '2026-05-20', narration: 'Into a closed account',
      lines: [{ accountId: empty.id, debitPaise: 100 }, { accountId: hdfc.id, creditPaise: 100 }],
    });
    expect(voucher.status).toBe(400);
    expect(voucher.body.message).toMatch(/inactive/);
  });

  it('refuses to change the type of an account that has postings', async () => {
    const res = await api.put(`/api/v1/ledger/accounts/${loan.id}`, { accountGroup: 'CURRENT_ASSET' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/cannot become asset/);
  });

  it('allows moving within the same type', async () => {
    const res = await api.put(`/api/v1/ledger/accounts/${loan.id}`, { accountGroup: 'CURRENT_LIABILITY' });
    expect(res.status).toBe(200);
    expect(res.body.data.accountGroup).toBe('CURRENT_LIABILITY');
  });
});

describe('The books still balance', () => {
  it('has equal debits and credits across the whole tenant', async () => {
    const tb = await api.get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`);
    const net = tb.body.data.reduce((sum, r) => sum + r.balancePaise, 0);
    expect(net).toBe(0);
  });
});
