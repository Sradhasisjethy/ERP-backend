const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, MixDesign, MixDesignLine, Party,
  AdGroup, AdGroupMember,
} = require('../src/models/index');

/**
 * Profit & Loss and Balance Sheet.
 *
 * One small year of business, every figure worked out by hand:
 *
 *   go-live stock     1,000 kg cement            @ ₹5   = ₹5,000   (brought in, not bought)
 *   goods receipt     2,000 kg cement, billed at ₹10,000
 *   production        100 pavers from 100 kg cement
 *   counter sale      10 pavers @ ₹500 + 18% GST, cash      revenue ₹500, GST ₹90
 *   expense           ₹20 diesel, cash
 *   journal           ₹30 rent from bank; ₹1,000 loan into bank
 *
 * Standard costs: cement ₹5/kg, paver ₹20.
 *   closing stock = 2,900 kg × ₹5 + 90 × ₹20 = ₹14,500 + ₹1,800 = ₹16,300
 *   gross profit  = 500 + 16,300 − 5,000 − 10,000 = ₹1,800
 *   net profit    = 1,800 − 20 − 30 = ₹1,750
 *
 * The balance sheet must then balance with that ₹1,750 in reserves and the
 * ₹5,000 of go-live stock as capital.
 */

const PASSWORD = 'password123';
let cookie;
let factory;
let otherFactory;
let tenantId;
let cement;
let paver;
let vendor;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const as = (c) => ({
  get: (url) => request(app).get(url).set('Cookie', c),
  post: (url, body) => request(app).post(url).set('Cookie', c).send(body),
});

const findLine = (section, name) => section.accounts.find((a) => a.name === name);

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Statements Precast', slug: 'statements-precast', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Statements Precast Pvt Ltd', code: 'SPL' });
  await User.create(
    { tenantId, email: 'admin@statements.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Statements Plant', code: 'STM', state: 'Odisha' });
  otherFactory = await Factory.create({ tenantId, organizationId: org.id, name: 'Empty Plant', code: 'EMP', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-STM' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast concrete', gstRatePercent: 18 });
  cement = await Product.create({
    tenantId, uomId: uom.id, name: 'Cement Stm', code: 'RM-CEM-STM', productType: 'RAW_MATERIAL', curingDays: 0, standardCostPaise: 500,
  });
  paver = await Product.create({
    tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Paver Stm', code: 'FG-PAV-STM', productType: 'FINISHED_GOOD', curingDays: 0, standardCostPaise: 2000,
  });
  const mix = await MixDesign.create({ tenantId, productId: paver.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: cement.id, quantityPerUnit: 1, uomId: uom.id });
  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Stm Cement Supplier' });

  cookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@statements.co', password: PASSWORD }),
    'accessToken'
  );
  const api = as(cookie);

  const opening = await api.post('/api/v1/migration/import', {
    kind: 'openingStock',
    rows: [{ factoryCode: 'STM', productCode: 'RM-CEM-STM', quantity: 1000, productionDate: '2026-03-01' }],
  });
  expect(opening.status).toBe(200);

  const grn = await api.post('/api/v1/purchasing/receipts', {
    factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-05-10',
    lines: [{ productId: cement.id, receivedQty: 2000, ratePaise: 500 }],
  });
  expect(grn.status).toBe(201);
  const bill = await api.post('/api/v1/purchasing/invoices', {
    factoryId: factory.id, goodsReceiptId: grn.body.data.id, vendorPartyId: vendor.id,
    vendorInvoiceNumber: 'STM/001', invoiceDate: '2026-05-10', dueDate: '2026-06-09', amountPaise: 1000000,
  });
  expect(bill.status).toBe(201);

  const production = await api.post('/api/v1/production/entries', {
    factoryId: factory.id, productId: paver.id, productionDate: '2026-05-15', goodQty: 100,
  });
  expect(production.status).toBe(201);

  const sale = await api.post('/api/v1/retail/counter-sales', {
    factoryId: factory.id, invoiceDate: '2026-06-01',
    customer: { name: 'Walk-in Stm', phone: '9800000001' },
    lines: [{ productId: paver.id, quantity: 10, ratePaise: 5000 }],
    payment: { modes: [{ mode: 'CASH', amountPaise: 59000 }] },
  });
  expect(sale.status).toBe(201);

  const expense = await api.post('/api/v1/expenses', {
    factoryId: factory.id, expenseDate: '2026-06-02', category: 'Diesel', mode: 'CASH', amountPaise: 2000,
  });
  expect(expense.status).toBe(201);

  const rent = (await api.post('/api/v1/ledger/accounts', { code: '5910', name: 'Rent', accountGroup: 'INDIRECT_EXPENSE' })).body.data;
  const loan = (await api.post('/api/v1/ledger/accounts', { code: '2500', name: 'Director Loan', accountGroup: 'LONG_TERM_LIABILITY' })).body.data;
  const hdfc = (await api.post('/api/v1/ledger/accounts', { code: '1011', name: 'HDFC', accountGroup: 'CURRENT_ASSET', subType: 'BANK' })).body.data;

  const loanIn = await api.post('/api/v1/ledger/vouchers', {
    factoryId: factory.id, voucherType: 'JOURNAL', voucherDate: '2026-06-03', narration: 'Loan received',
    lines: [{ accountId: hdfc.id, debitPaise: 100000 }, { accountId: loan.id, creditPaise: 100000 }],
  });
  expect(loanIn.status).toBe(201);
  const rentPaid = await api.post('/api/v1/ledger/vouchers', {
    factoryId: factory.id, voucherType: 'JOURNAL', voucherDate: '2026-06-04', narration: 'Rent',
    lines: [{ accountId: rent.id, debitPaise: 3000 }, { accountId: hdfc.id, creditPaise: 3000 }],
  });
  expect(rentPaid.status).toBe(201);
});

afterAll(async () => {
  await sequelize.close();
});

describe('Profit & Loss for the year', () => {
  let pl;

  beforeAll(async () => {
    const res = await as(cookie).get(`/api/v1/ledger/profit-and-loss?from=2026-04-01&to=2027-03-31&factoryId=${factory.id}`);
    expect(res.status).toBe(200);
    pl = res.body.data;
  });

  it('counts go-live stock as opening stock, not as something this year produced', () => {
    expect(pl.trading.openingStockPaise).toBe(500000);
  });

  it('values closing stock at standard cost', () => {
    expect(pl.trading.closingStockPaise).toBe(1630000);
    expect(pl.stockValuation.unvaluedProducts).toBe(0);
  });

  it('puts sales and purchases in the trading section', () => {
    expect(findLine(pl.trading.directIncome, 'Sales Revenue').amountPaise).toBe(50000);
    expect(findLine(pl.trading.directExpense, 'Purchase Expense').amountPaise).toBe(1000000);
  });

  it('works out gross and net profit', () => {
    expect(pl.trading.grossProfitPaise).toBe(180000);
    expect(findLine(pl.indirectExpense, 'Factory Expenses').amountPaise).toBe(2000);
    expect(findLine(pl.indirectExpense, 'Rent').amountPaise).toBe(3000);
    expect(pl.netProfitPaise).toBe(175000);
  });

  it('leaves GST out of income — it is owed to the government', () => {
    const names = [...pl.trading.directIncome.accounts, ...pl.indirectIncome.accounts].map((a) => a.name);
    expect(names.some((n) => /GST/.test(n))).toBe(false);
  });

  it('defaults to the current financial year when no dates are given', async () => {
    const res = await as(cookie).get(`/api/v1/ledger/profit-and-loss?factoryId=${factory.id}`);
    expect(res.status).toBe(200);
    expect(res.body.data.from).toBe('2026-04-01');
    expect(res.body.data.netProfitPaise).toBe(175000);
  });

  it('is empty for a factory with no activity', async () => {
    const res = await as(cookie).get(`/api/v1/ledger/profit-and-loss?from=2026-04-01&to=2027-03-31&factoryId=${otherFactory.id}`);
    expect(res.body.data.netProfitPaise).toBe(0);
    expect(res.body.data.trading.closingStockPaise).toBe(0);
  });

  it('refuses a range that ends before it starts', async () => {
    const res = await as(cookie).get('/api/v1/ledger/profit-and-loss?from=2026-06-01&to=2026-05-01');
    expect(res.status).toBe(400);
  });
});

describe('Balance Sheet', () => {
  let bs;

  beforeAll(async () => {
    const res = await as(cookie).get(`/api/v1/ledger/balance-sheet?asOf=2027-03-31&factoryId=${factory.id}`);
    expect(res.status).toBe(200);
    bs = res.body.data;
  });

  const section = (list, group) => list.find((s) => s.group === group);

  it('balances', () => {
    expect(bs.differencePaise).toBe(0);
    expect(bs.totalAssetsPaise).toBe(bs.totalLiabilitiesAndCapitalPaise);
  });

  it('shows cash, bank and stock as current assets', () => {
    const current = section(bs.assets, 'CURRENT_ASSET');
    expect(findLine(current, 'Cash-in-Hand').amountPaise).toBe(57000);
    expect(findLine(current, 'HDFC').amountPaise).toBe(97000);
    expect(findLine(current, 'Closing Stock (at standard cost)').amountPaise).toBe(1630000);
    expect(bs.totalAssetsPaise).toBe(1784000);
  });

  it('shows what is owed: the supplier, the GST and the loan', () => {
    expect(findLine(section(bs.liabilities, 'CURRENT_LIABILITY'), 'Accounts Payable').amountPaise).toBe(1000000);
    expect(section(bs.liabilities, 'DUTIES_TAXES').totalPaise).toBe(9000);
    expect(findLine(section(bs.liabilities, 'LONG_TERM_LIABILITY'), 'Director Loan').amountPaise).toBe(100000);
  });

  it('carries the year’s profit and the go-live stock in capital', () => {
    expect(findLine(section(bs.capital, 'RESERVES'), 'Profit & Loss Account').amountPaise).toBe(175000);
    expect(findLine(section(bs.capital, 'CAPITAL'), 'Opening Stock brought in at go-live').amountPaise).toBe(500000);
  });

  it('still balances across every factory together', async () => {
    const res = await as(cookie).get('/api/v1/ledger/balance-sheet?asOf=2027-03-31');
    expect(res.status).toBe(200);
    expect(res.body.data.differencePaise).toBe(0);
  });
});

describe('Who may see them', () => {
  it('refuses someone who can read the ledger but not see amounts', async () => {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await User.create(
      { tenantId, email: 'clerk@statements.co', passwordHash, firstName: 'Ledger', lastName: 'Clerk', role: 'EMPLOYEE' },
      { validate: false }
    );
    const group = await AdGroup.create({ tenantId, name: 'Ledger readers', permissions: ['LEDGER_READ'] });
    await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });
    const clerk = extractCookie(
      await request(app).post('/api/v1/auth/login').send({ email: 'clerk@statements.co', password: PASSWORD }),
      'accessToken'
    );

    const res = await as(clerk).get('/api/v1/ledger/profit-and-loss');
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/View rates and amounts/);
  });
});

describe('Receivables and payables ageing', () => {
  let customerId;

  beforeAll(async () => {
    // Runs after the statement assertions above, so it does not disturb them.
    const sale = await as(cookie).post('/api/v1/retail/counter-sales', {
      factoryId: factory.id, invoiceDate: '2026-08-01',
      customer: { name: 'Credit Buyer Stm', phone: '9800000002' },
      lines: [{ productId: paver.id, quantity: 5, ratePaise: 5000 }],
    });
    expect(sale.status).toBe(201);
    customerId = sale.body.data.customer.id;
  });

  const BUCKETS = ['notDuePaise', 'days1to30Paise', 'days31to60Paise', 'days61to90Paise', 'days90PlusPaise'];

  it('puts each customer on one row with their open amount in exactly one bucket', async () => {
    const res = await as(cookie).get('/api/v1/reports/finance/receivables-ageing').query({ factoryId: factory.id });
    expect(res.status).toBe(200);
    const row = res.body.data.rows.find((r) => r.id === customerId);
    expect(row.partyName).toBe('Credit Buyer Stm');
    expect(row.outstandingPaise).toBe(29500);
    expect(row.invoiceCount).toBe(1);
    const filled = BUCKETS.filter((b) => row[b] !== 0);
    expect(filled).toHaveLength(1);
    expect(row[filled[0]]).toBe(29500);
    // A cash sale settled at the counter is not a receivable.
    expect(res.body.data.rows.some((r) => r.partyName === 'Walk-in Stm')).toBe(false);
  });

  it('ages the unpaid supplier bill past 90 days', async () => {
    const res = await as(cookie).get('/api/v1/reports/finance/payables-ageing').query({ factoryId: factory.id });
    expect(res.status).toBe(200);
    const row = res.body.data.rows.find((r) => r.id === vendor.id);
    expect(row.outstandingPaise).toBe(1000000);
    expect(row.days90PlusPaise).toBe(1000000);
    expect(res.body.data.summary.days90PlusPaise).toBe(1000000);
  });
});
