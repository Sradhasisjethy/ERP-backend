const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, MixDesign, MixDesignLine, Party,
} = require('../src/models/index');
const { isoDateInZone } = require('../src/utils/dateDisplay');
const { env } = require('../src/config/env');

/**
 * One enquiry, followed all the way to the money and the books.
 *
 *   lead → quotation → sales order → challan → invoice → receipt
 *
 * with a fixed asset bought, depreciated, and a till opened and closed over the
 * same period. Every feature added on 2026-09-22 appears here in the company of
 * the ones that were already there, because the thing worth proving is not that
 * each works alone — the feature tests do that — but that the ledger still
 * balances and the statements still tie once they all run together.
 */

const PASSWORD = 'password123';
const day = (offset) => isoDateInZone(new Date(Date.now() + offset * 86400000), env.APP_TIMEZONE);

let api;
let factory;
let cement;
let pipe;
let vendor;
let hdfc;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const ok = (res, expected = 201) => {
  if (res.status !== expected) throw new Error(`${expected} expected, got ${res.status}: ${res.body.message || ''}`);
  return res.body.data;
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'E2E Precast', slug: 'e2e-precast', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'E2E Precast Pvt Ltd', code: 'EPL' });
  await User.create(
    { tenantId, email: 'admin@e2e.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Asha', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'E2E Plant', code: 'E2E', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-E2E' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast concrete', gstRatePercent: 18 });
  cement = await Product.create({ tenantId, uomId: uom.id, name: 'Cement E2E', code: 'RM-CEM-E2E', productType: 'RAW_MATERIAL', curingDays: 0, standardCostPaise: 500 });
  pipe = await Product.create({
    tenantId, uomId: uom.id, hsnId: hsn.id, name: 'RCC Pipe 600mm E2E', code: 'FG-PIPE-E2E',
    productType: 'FINISHED_GOOD', curingDays: 0, standardCostPaise: 4000, sellingPricePaise: 10000,
  });
  const mix = await MixDesign.create({ tenantId, productId: pipe.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: cement.id, quantityPerUnit: 2, uomId: uom.id });
  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'E2E Cement Co', state: 'Odisha' });

  const cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@e2e.co', password: PASSWORD }), 'accessToken');
  api = {
    get: (url, query) => request(app).get(url).set('Cookie', cookie).query(query || {}),
    post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
    put: (url, body) => request(app).put(url).set('Cookie', cookie).send(body),
  };

  hdfc = ok(await api.post('/api/v1/ledger/accounts', {
    code: '1011', name: 'HDFC Current A/c', accountGroup: 'CURRENT_ASSET', subType: 'BANK',
    openingBalance: { factoryId: factory.id, asOfDate: day(-60), amountPaise: 50000000 },
  }));

  // Raw material in, pipes cast.
  const grn = ok(await api.post('/api/v1/purchasing/receipts', {
    factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: day(-30),
    lines: [{ productId: cement.id, receivedQty: 1000, ratePaise: 500 }],
  }));
  ok(await api.post('/api/v1/purchasing/invoices', {
    factoryId: factory.id, goodsReceiptId: grn.id, vendorPartyId: vendor.id,
    vendorInvoiceNumber: 'E2E/CEM/1', invoiceDate: day(-30), dueDate: day(0), amountPaise: 500000,
  }));
  ok(await api.post('/api/v1/production/entries', { factoryId: factory.id, productId: pipe.id, productionDate: day(-20), goodQty: 200 }));
});

afterAll(async () => {
  await sequelize.close();
});

describe('An enquiry becomes money in the bank', () => {
  let lead;
  let quote;
  let order;
  let invoice;

  it('starts as a lead somebody follows up', async () => {
    lead = ok(await api.post('/api/v1/crm/leads', {
      name: 'Odisha Rural Works', contactName: 'Bikash Nayak', phone: '9861230000',
      source: 'TENDER', state: 'Odisha', estimatedValuePaise: 20000000, requirement: '150 pipes, 600mm',
    }));
    ok(await api.post(`/api/v1/crm/leads/${lead.id}/activities`, { type: 'SITE_VISIT', subject: 'Measured the site' }));
    expect((await api.get(`/api/v1/crm/leads/${lead.id}`)).body.data.status).toBe('CONTACTED');
  });

  it('is quoted, which moves the lead to quoted', async () => {
    quote = ok(await api.post('/api/v1/quotations', {
      factoryId: factory.id, quotationDate: day(-10), validUntil: day(20), leadId: lead.id,
      prospect: { name: 'Odisha Rural Works', phone: '9861230000', state: 'Odisha' },
      lines: [{ productId: pipe.id, quantity: 150, ratePaise: 10000, discountPercent: 5 }],
      terms: '50% advance, delivery in three weeks',
    }));
    // 150 × ₹100 less 5% = ₹14,250 taxable, 18% GST = ₹2,565 → ₹16,815.
    expect(quote.subtotalPaise).toBe(1425000);
    expect(quote.totalPaise).toBe(1681500);
    expect((await api.get(`/api/v1/crm/leads/${lead.id}`)).body.data.status).toBe('QUOTED');
  });

  it('converts to a sales order at the quoted net rate, and the prospect becomes a customer', async () => {
    const converted = ok(await api.post(`/api/v1/quotations/${quote.id}/convert`, { orderDate: day(-8) }));
    order = converted.order;
    expect(Number(order.totalAmountPaise)).toBe(1425000);
    expect(converted.roundingDifferencePaise).toBe(0);

    const customer = await Party.findOne({ where: { name: 'Odisha Rural Works', partyType: 'CUSTOMER' } });
    expect(customer).toBeTruthy();
    expect((await api.get(`/api/v1/quotations/${quote.id}`)).body.data.status).toBe('CONVERTED');
  });

  it('marks the lead won when the customer is on the books', async () => {
    const won = ok(await api.post(`/api/v1/crm/leads/${lead.id}/convert`, {}));
    expect(won.lead.status).toBe('WON');
    const pipeline = (await api.get('/api/v1/crm/pipeline')).body.data;
    expect(pipeline.stages.find((s) => s.status === 'WON').count).toBe(1);
    expect(pipeline.openCount).toBe(0);
  });

  it('dispatches and invoices the order', async () => {
    ok(await api.put(`/api/v1/sales/orders/${order.id}/confirm`, {}), 200);
    const challan = ok(await api.post('/api/v1/dispatch/challans', {
      salesOrderId: order.id, vehicleNumber: 'OD-02-AB-1234', dispatchDate: day(-2),
      lines: [{ salesOrderLineId: order.lines[0].id, dispatchedQty: 150 }],
    }));
    invoice = ok(await api.post('/api/v1/invoices', { challanIds: [challan.id], invoiceDate: day(-1) }));
    expect(Number(invoice.subtotalPaise)).toBe(1425000);
    expect(Number(invoice.totalPaise)).toBe(1681500);
  });

  it('collects the money into the named bank account', async () => {
    const customer = await Party.findOne({ where: { name: 'Odisha Rural Works', partyType: 'CUSTOMER' } });
    ok(await api.post('/api/v1/receipts', {
      factoryId: factory.id, customerPartyId: customer.id, receiptDate: day(-1),
      modes: [{ mode: 'BANK', amountPaise: 1681500, reference: 'UTR-E2E', accountId: hdfc.id }],
      allocations: [{ invoiceId: invoice.id, allocatedAmountPaise: 1681500 }],
    }));

    const tb = (await api.get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`)).body.data;
    const hdfcRow = tb.find((r) => r.code === '1011');
    expect(hdfcRow.balancePaise).toBe(50000000 + 1681500);
    // Nothing is left owing on that invoice.
    const receivable = tb.find((r) => r.code === '1100');
    expect(receivable.balancePaise).toBe(0);
  });
});

describe('The books still hold after everything else runs too', () => {
  it('buys a mould, depreciates it, and opens and closes the till', async () => {
    const asset = ok(await api.post('/api/v1/fixed-assets', {
      factoryId: factory.id, name: 'Pipe Mould 600mm', category: 'Moulds', acquisitionType: 'PURCHASED',
      acquisitionDate: day(-40), costPaise: 2400000, method: 'SLM', usefulLifeMonths: 24,
      payment: { mode: 'BANK', accountId: hdfc.id },
    }));
    const run = ok(await api.post('/api/v1/fixed-assets/depreciation/runs', { factoryId: factory.id, upTo: day(0) }));
    expect(run.totalPaise).toBeGreaterThan(0);

    const till = ok(await api.post('/api/v1/cash-register/sessions', { factoryId: factory.id, denominations: {} }));
    // A walk-in pays cash while the till is open.
    ok(await api.post('/api/v1/retail/counter-sales', {
      factoryId: factory.id, invoiceDate: day(0),
      customer: { name: 'Walk-in E2E', phone: '9800000123' },
      lines: [{ productId: pipe.id, quantity: 10, ratePaise: 10000 }],
      payment: { modes: [{ mode: 'CASH', amountPaise: 118000 }] },
    }));
    const detail = (await api.get(`/api/v1/cash-register/sessions/${till.id}`)).body.data;
    expect(detail.totalInPaise).toBe(118000);
    expect(detail.expectedNowPaise).toBe(118000);

    const closed = ok(await api.put(`/api/v1/cash-register/sessions/${till.id}/close`, {
      denominations: { 500: 2, 100: 1, 50: 1, 20: 1, 10: 1 },
    }), 200);
    expect(closed.closingCountedPaise).toBe(118000);
    expect(closed.closingVariancePaise).toBe(0);
    expect(asset.bookValuePaise).toBe(2400000);
  });

  it('leaves a balance sheet that balances and a P&L that ties to it', async () => {
    const bs = (await api.get('/api/v1/ledger/balance-sheet', { asOf: day(0), factoryId: factory.id })).body.data;
    expect(bs.differencePaise).toBe(0);
    expect(bs.totalAssetsPaise).toBe(bs.totalLiabilitiesAndCapitalPaise);

    const pl = (await api.get('/api/v1/ledger/profit-and-loss', { from: '2026-04-01', to: day(0), factoryId: factory.id })).body.data;
    // Everything this tenant has ever done falls in this window, so the profit
    // for it is exactly what the balance sheet carries in reserves.
    const reserves = bs.capital.find((s) => s.group === 'RESERVES');
    const retained = reserves.accounts.find((a) => a.name === 'Profit & Loss Account');
    expect(retained.amountPaise).toBe(pl.netProfitPaise);
  });

  it('shows the sale in GSTR-1 and the same tax in the rate summary', async () => {
    const period = { factoryId: factory.id, fromDate: '2026-04-01', toDate: day(0) };
    const gstr1 = (await api.get('/api/v1/gstr/gstr1', period)).body.data;
    const rates = (await api.get('/api/v1/gstr/tax-rate-summary', period)).body.data;

    const outputTax = gstr1.summary.cgstPaise + gstr1.summary.sgstPaise + gstr1.summary.igstPaise;
    expect(rates.totals.outward.totalTaxPaise).toBe(outputTax);
    expect(rates.totals.outward.taxableValuePaise).toBe(gstr1.summary.taxableValuePaise);
    // The credit sale is B2C (no GSTIN on the customer) and so is the walk-in.
    expect(gstr1.b2c.length).toBe(2);
  });

  it('ages the one thing still owed: the cement bill', async () => {
    const payables = (await api.get('/api/v1/reports/finance/payables-ageing')).body.data;
    const row = payables.rows.find((r) => r.partyName === 'E2E Cement Co');
    expect(row.outstandingPaise).toBe(500000);
    expect(row.invoiceCount).toBe(1);

    const receivables = (await api.get('/api/v1/reports/finance/receivables-ageing')).body.data;
    // Both sales were settled in full, so nobody owes us anything.
    expect(receivables.rows).toHaveLength(0);
  });
});
