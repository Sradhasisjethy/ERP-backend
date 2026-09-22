const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, Party, AdGroup, AdGroupMember,
} = require('../src/models/index');
const { UserFactory } = require('../src/api/factory/userFactory.model');
const { CashRegisterSession } = require('../src/api/cashRegister/cashRegisterSession.model');

/**
 * Adversarial pass over the features added on 2026-09-22.
 *
 * These are the cases a feature test does not cover because it is busy proving
 * the happy path works: someone typing the wrong year, someone with access to
 * one plant reaching into another, someone who may not see money, two people
 * pressing the same button at once, and the shapes an API promises.
 */

const PASSWORD = 'password123';
const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const login = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

const as = (cookie) => ({
  get: (url, query) => request(app).get(url).set('Cookie', cookie).query(query || {}),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookie).send(body),
});

/**
 * Dates relative to the business day, not to UTC — the tests must not rot, and
 * must not disagree with the app about which day it is. After 18:30 UTC,
 * "UTC tomorrow" is already today in Asia/Kolkata, which is exactly the trap
 * this helper exists to avoid.
 */
const { isoDateInZone } = require('../src/utils/dateDisplay');
const { env } = require('../src/config/env');
const isoAfter = (days) => isoDateInZone(new Date(Date.now() + days * 86400000), env.APP_TIMEZONE);
const TOMORROW = isoAfter(1);
const YESTERDAY = isoAfter(-1);

let tenantId;
let admin;       // platform admin, unrestricted
let plantA;
let plantB;
let hdfc;
let rent;
let paver;
let customer;
let clerk;       // may read the modules but may not see money
let bOnly;       // assigned to plant B only

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'QA Precast', slug: 'qa-precast', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'QA Precast Pvt Ltd', code: 'QAP' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  await User.create(
    { tenantId, email: 'admin@qa.co', passwordHash, firstName: 'Asha', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  plantA = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant A', code: 'QA-A', state: 'Odisha' });
  plantB = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant B', code: 'QA-B', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-QA' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast', gstRatePercent: 18 });
  paver = await Product.create({
    tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Paver QA', code: 'FG-PAV-QA',
    productType: 'FINISHED_GOOD', curingDays: 0, sellingPricePaise: 5000, standardCostPaise: 2000,
  });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'QA Buyer', state: 'Odisha' });

  admin = as(await login('admin@qa.co'));

  // Every module readable, but no VIEW_RATES: money must be stripped everywhere.
  const clerkUser = await User.create(
    { tenantId, email: 'clerk@qa.co', passwordHash, firstName: 'Ravi', lastName: 'Clerk', role: 'EMPLOYEE' },
    { validate: false }
  );
  const clerkGroup = await AdGroup.create({
    tenantId, name: 'Readers',
    permissions: ['LEDGER_READ', 'JOURNAL_READ', 'FIXED_ASSET_READ', 'QUOTATION_READ', 'CASH_REGISTER_READ', 'LEAD_READ', 'GSTR_READ'],
  });
  await AdGroupMember.create({ tenantId, adGroupId: clerkGroup.id, employeeId: clerkUser.id });
  // Assigned to Plant A, or location scoping would hand back an empty list and
  // every masking assertion below would pass without proving anything.
  await UserFactory.create({ tenantId, userId: clerkUser.id, factoryId: plantA.id });
  clerk = as(await login('clerk@qa.co'));

  // Assigned to Plant B only, with write access to everything new.
  const bUser = await User.create(
    { tenantId, email: 'bonly@qa.co', passwordHash, firstName: 'Bina', lastName: 'Bee', role: 'EMPLOYEE' },
    { validate: false }
  );
  const bGroup = await AdGroup.create({
    tenantId, name: 'Plant B staff',
    permissions: [
      'LEDGER_READ', 'JOURNAL_READ', 'JOURNAL_CREATE', 'JOURNAL_MODIFY',
      'FIXED_ASSET_READ', 'FIXED_ASSET_CREATE', 'FIXED_ASSET_MODIFY',
      'CASH_REGISTER_READ', 'CASH_REGISTER_CREATE', 'CASH_REGISTER_MODIFY',
      'STAFF_ATTENDANCE_READ', 'STAFF_ATTENDANCE_CREATE', 'VIEW_RATES',
    ],
  });
  await AdGroupMember.create({ tenantId, adGroupId: bGroup.id, employeeId: bUser.id });
  await UserFactory.create({ tenantId, userId: bUser.id, factoryId: plantB.id });
  bOnly = as(await login('bonly@qa.co'));

  hdfc = (await admin.post('/api/v1/ledger/accounts', {
    code: '1011', name: 'HDFC', accountGroup: 'CURRENT_ASSET', subType: 'BANK',
    openingBalance: { factoryId: plantA.id, asOfDate: '2026-04-01', amountPaise: 10000000 },
  })).body.data;
  rent = (await admin.post('/api/v1/ledger/accounts', { code: '5910', name: 'Rent', accountGroup: 'INDIRECT_EXPENSE' })).body.data;
});

afterAll(async () => {
  await sequelize.close();
});

// ---------------------------------------------------------------------------

describe('Nothing may be posted into the future', () => {
  it('refuses a voucher dated tomorrow', async () => {
    const res = await admin.post('/api/v1/ledger/vouchers', {
      factoryId: plantA.id, voucherType: 'JOURNAL', voucherDate: TOMORROW, narration: 'Next month rent',
      lines: [{ accountId: rent.id, debitPaise: 1000 }, { accountId: hdfc.id, creditPaise: 1000 }],
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/future/);
  });

  it('refuses an asset acquired tomorrow', async () => {
    const res = await admin.post('/api/v1/fixed-assets', {
      factoryId: plantA.id, name: 'Future mould', category: 'Moulds', acquisitionType: 'PURCHASED',
      acquisitionDate: TOMORROW, costPaise: 100000, method: 'SLM', usefulLifeMonths: 12, payment: { mode: 'BANK' },
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/future/);
  });

  it('refuses a depreciation run and a disposal dated ahead of today', async () => {
    const asset = await admin.post('/api/v1/fixed-assets', {
      factoryId: plantA.id, name: 'Mould QA', category: 'Moulds', acquisitionType: 'PURCHASED',
      acquisitionDate: '2026-04-01', costPaise: 1200000, method: 'SLM', usefulLifeMonths: 12,
      payment: { mode: 'BANK', accountId: hdfc.id },
    });
    expect(asset.status).toBe(201);

    const run = await admin.post('/api/v1/fixed-assets/depreciation/runs', { factoryId: plantA.id, upTo: isoAfter(3650) });
    expect(run.status).toBe(400);
    expect(run.body.message).toMatch(/future/);

    const disposal = await admin.put(`/api/v1/fixed-assets/${asset.body.data.id}/dispose`, { disposedOn: TOMORROW });
    expect(disposal.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------

describe('A user assigned to one plant cannot reach another (BR-29)', () => {
  let voucherA;
  let runA;

  beforeAll(async () => {
    voucherA = (await admin.post('/api/v1/ledger/vouchers', {
      factoryId: plantA.id, voucherType: 'JOURNAL', voucherDate: YESTERDAY, narration: 'Plant A rent',
      lines: [{ accountId: rent.id, debitPaise: 5000 }, { accountId: hdfc.id, creditPaise: 5000 }],
    })).body.data;
    runA = (await admin.post('/api/v1/fixed-assets/depreciation/runs', { factoryId: plantA.id, upTo: YESTERDAY })).body.data;
  });

  it('cannot read or cancel another plant’s voucher', async () => {
    expect((await bOnly.get(`/api/v1/ledger/vouchers/${voucherA.id}`)).status).toBe(404);
    expect((await bOnly.put(`/api/v1/ledger/vouchers/${voucherA.id}/cancel`, { reason: 'Nosy' })).status).toBe(404);
  });

  it('cannot post a voucher against another plant', async () => {
    const res = await bOnly.post('/api/v1/ledger/vouchers', {
      factoryId: plantA.id, voucherType: 'JOURNAL', voucherDate: YESTERDAY, narration: 'Not mine',
      lines: [{ accountId: rent.id, debitPaise: 100 }, { accountId: hdfc.id, creditPaise: 100 }],
    });
    expect(res.status).toBe(403);
  });

  it('cannot undo another plant’s depreciation run', async () => {
    const res = await bOnly.put(`/api/v1/fixed-assets/depreciation/runs/${runA.id}/cancel`, { reason: 'Nosy' });
    expect(res.status).toBe(404);
    // And the run is still posted.
    expect((await admin.get('/api/v1/fixed-assets/depreciation/runs', { page: 1, limit: 10 })).body.data.rows[0].status).toBe('POSTED');
  });

  it('cannot open a till or mark attendance at another plant', async () => {
    expect((await bOnly.post('/api/v1/cash-register/sessions', { factoryId: plantA.id, denominations: {} })).status).toBe(403);
    const attendance = await bOnly.post('/api/v1/hr/attendance', {
      attendanceDate: YESTERDAY, factoryId: plantA.id,
      entries: [{ employeeId: (await User.findOne({ where: { email: 'bonly@qa.co' } })).id, status: 'PRESENT' }],
    });
    expect(attendance.status).toBe(403);
  });

  it('sees only its own plant’s assets in the register', async () => {
    const res = await bOnly.get('/api/v1/fixed-assets', { page: 1, limit: 50 });
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------

describe('Money is stripped from a user who may not see rates (BR-27)', () => {
  let quote;
  let lead;

  beforeAll(async () => {
    quote = (await admin.post('/api/v1/quotations', {
      factoryId: plantA.id, quotationDate: YESTERDAY, validUntil: isoAfter(30),
      customerPartyId: customer.id, lines: [{ productId: paver.id, quantity: 4, ratePaise: 5000 }],
    })).body.data;
    lead = (await admin.post('/api/v1/crm/leads', { name: 'QA Lead', source: 'PHONE', estimatedValuePaise: 9900000 })).body.data;
  });

  it('nulls the amounts on vouchers, assets, quotations, tills and leads', async () => {
    const voucher = await clerk.get('/api/v1/ledger/vouchers', { page: 1, limit: 5 });
    expect(voucher.body.data.rows.length).toBeGreaterThan(0);
    expect(voucher.body.data.rows.every((v) => v.totalPaise === null)).toBe(true);

    const assets = await clerk.get('/api/v1/fixed-assets', { page: 1, limit: 5 });
    expect(assets.body.data.rows.length).toBeGreaterThan(0);
    expect(assets.body.data.rows.every((a) => a.costPaise === null && a.bookValuePaise === null)).toBe(true);

    const quotations = await clerk.get('/api/v1/quotations', { page: 1, limit: 5 });
    const seen = quotations.body.data.rows.find((q) => q.id === quote.id);
    expect(seen.totalPaise).toBeNull();
    expect(seen.lines.every((l) => l.ratePaise === null && l.taxableAmountPaise === null)).toBe(true);

    const leads = await clerk.get('/api/v1/crm/leads', { page: 1, limit: 5 });
    expect(leads.body.data.rows.find((l) => l.id === lead.id).estimatedValuePaise).toBeNull();
  });

  it('refuses the statements and the GST returns that are nothing but amounts', async () => {
    for (const url of ['/api/v1/ledger/profit-and-loss', '/api/v1/ledger/balance-sheet']) {
      expect((await clerk.get(url)).status).toBe(403);
    }
    const gst = { factoryId: plantA.id, fromDate: '2026-04-01', toDate: '2026-06-30' };
    expect((await clerk.get('/api/v1/gstr/tax-rate-summary', gst)).status).toBe(403);
    expect((await clerk.get('/api/v1/gstr/gstr9', gst)).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('Every new route refuses a user without its permission', () => {
  const cases = [
    ['post', '/api/v1/ledger/accounts', { code: 'X1', name: 'X', accountGroup: 'CURRENT_ASSET' }],
    ['post', '/api/v1/ledger/vouchers', { factoryId: null, voucherType: 'JOURNAL', voucherDate: '2026-06-01', narration: 'x', lines: [] }],
    ['post', '/api/v1/fixed-assets', {}],
    ['post', '/api/v1/quotations', {}],
    ['post', '/api/v1/cash-register/sessions', {}],
    ['post', '/api/v1/crm/leads', { name: 'x' }],
    ['post', '/api/v1/hr/leave-requests', {}],
    ['post', '/api/v1/hr/attendance', {}],
  ];

  it.each(cases)('refuses %s %s', async (method, url, body) => {
    const res = await clerk[method](url, body);
    expect(res.status).toBe(403);
  });

  it('refuses reads too, module by module', async () => {
    // The clerk has no HR permissions at all.
    expect((await clerk.get('/api/v1/hr/leave-requests', { page: 1, limit: 5 })).status).toBe(403);
    expect((await clerk.get('/api/v1/hr/attendance/roster', { date: YESTERDAY })).status).toBe(403);
  });
});

// ---------------------------------------------------------------------------

describe('Data that must not contradict itself', () => {
  it('reports a voucher total as a number in the list, exactly as the detail does', async () => {
    const list = await admin.get('/api/v1/ledger/vouchers', { page: 1, limit: 5 });
    const row = list.body.data.rows[0];
    expect(typeof row.totalPaise).toBe('number');
    const detail = await admin.get(`/api/v1/ledger/vouchers/${row.id}`);
    expect(detail.body.data.totalPaise).toBe(row.totalPaise);
  });

  it('will not deactivate the account a till is open on', async () => {
    const petty = (await admin.post('/api/v1/ledger/accounts', { code: '1002', name: 'QA Petty Cash', accountGroup: 'CURRENT_ASSET', subType: 'CASH' })).body.data;
    const session = await admin.post('/api/v1/cash-register/sessions', { factoryId: plantA.id, accountId: petty.id, denominations: {} });
    expect(session.status).toBe(201);

    const deactivate = await admin.put(`/api/v1/ledger/accounts/${petty.id}`, { isActive: false });
    expect(deactivate.status).toBe(400);
    expect(deactivate.body.message).toMatch(/still open/);

    // Closed, it deactivates — and the till can always be closed.
    expect((await admin.put(`/api/v1/cash-register/sessions/${session.body.data.id}/close`, { denominations: {} })).status).toBe(200);
    expect((await admin.put(`/api/v1/ledger/accounts/${petty.id}`, { isActive: false })).status).toBe(200);
  });

  it('lets only one till be open per account, even when two requests race', async () => {
    const [first, second] = await Promise.all([
      admin.post('/api/v1/cash-register/sessions', { factoryId: plantB.id, denominations: {} }),
      admin.post('/api/v1/cash-register/sessions', { factoryId: plantB.id, denominations: {} }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);
    expect(await CashRegisterSession.count({ where: { factoryId: plantB.id, status: 'OPEN' } })).toBe(1);
  });

  it('refuses a GSTR-9 range that is not a year', async () => {
    const res = await admin.get('/api/v1/gstr/gstr9', { factoryId: plantA.id, fromDate: '2020-04-01', toDate: '2027-03-31' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/one financial year/);
  });

  it('refuses a follow-up task with no date it is due by', async () => {
    const lead = (await admin.post('/api/v1/crm/leads', { name: 'Task QA', source: 'PHONE' })).body.data;
    const res = await admin.post(`/api/v1/crm/leads/${lead.id}/activities`, { type: 'TASK', subject: 'Chase it' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/due by/);
  });

  it('records no leave or attendance against someone who has left', async () => {
    const gone = await User.create(
      { tenantId, email: 'gone@qa.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Gita', lastName: 'Gone', role: 'EMPLOYEE', status: 'TERMINATED' },
      { validate: false }
    );
    const type = (await admin.post('/api/v1/hr/leave-types', { code: 'QACL', name: 'QA Casual', daysPerYear: 10 })).body.data;

    const leave = await admin.post('/api/v1/hr/leave-requests', {
      employeeId: gone.id, leaveTypeId: type.id, fromDate: YESTERDAY, toDate: YESTERDAY,
    });
    expect(leave.status).toBe(400);
    expect(leave.body.message).toMatch(/has left/);

    const attendance = await admin.post('/api/v1/hr/attendance', {
      attendanceDate: YESTERDAY, entries: [{ employeeId: gone.id, status: 'PRESENT' }],
    });
    expect(attendance.status).toBe(400);
    // The roster does not offer them either.
    const roster = await admin.get('/api/v1/hr/attendance/roster', { date: YESTERDAY });
    expect(roster.body.data.rows.map((r) => r.employeeId)).not.toContain(gone.id);
  });

  it('reports the rounding when a quoted amount cannot divide into a whole rate', async () => {
    // ₹10.00 over 3 pieces: 333.33 paise each, which a rate cannot hold.
    const quote = (await admin.post('/api/v1/quotations', {
      factoryId: plantA.id, quotationDate: YESTERDAY, validUntil: isoAfter(10),
      customerPartyId: customer.id, lines: [{ productId: paver.id, quantity: 3, ratePaise: 334 }],
    })).body.data;

    const res = await admin.post(`/api/v1/quotations/${quote.id}/convert`, {});
    expect(res.status).toBe(201);
    expect(typeof res.body.data.roundingDifferencePaise).toBe('number');
    expect(Math.abs(res.body.data.roundingDifferencePaise)).toBeLessThanOrEqual(2);
  });

  it('sorts the ageing report by a bucket column when asked', async () => {
    const res = await admin.get('/api/v1/reports/finance/receivables-ageing', {
      page: 1, limit: 10, sortBy: 'days90PlusPaise', sortDir: 'desc',
    });
    expect(res.status).toBe(200);
    expect(res.body.data.sort).toMatchObject({ by: 'days90PlusPaise', dir: 'desc' });
  });
});

// ---------------------------------------------------------------------------

describe('One tenant never sees another', () => {
  it('keeps leads, quotations, assets and vouchers inside their own tenant', async () => {
    const other = await Tenant.create({ name: 'Rival Precast', slug: 'rival-qa', status: 'active' });
    const org = await Organization.create({ tenantId: other.id, name: 'Rival Pvt Ltd', code: 'RVL' });
    await Factory.create({ tenantId: other.id, organizationId: org.id, name: 'Rival Plant', code: 'RVL-1', state: 'Odisha' });
    await FinancialYear.create({ tenantId: other.id, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
    await User.create(
      { tenantId: other.id, email: 'admin@rival.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Ravi', lastName: 'Rival', role: 'PLATFORM_ADMIN' },
      { validate: false }
    );
    const rival = as(await login('admin@rival.co'));

    for (const url of ['/api/v1/crm/leads', '/api/v1/quotations', '/api/v1/fixed-assets', '/api/v1/ledger/vouchers']) {
      const res = await rival.get(url, { page: 1, limit: 50 });
      expect(res.status).toBe(200);
      expect(res.body.data.rows).toHaveLength(0);
    }
    // And the chart of accounts starts empty rather than showing ours.
    const accounts = await rival.get('/api/v1/ledger/accounts');
    expect(accounts.body.data.find((a) => a.code === '1011')).toBeUndefined();
  });
});
