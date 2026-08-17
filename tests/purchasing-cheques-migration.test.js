const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode,
  MixDesign, MixDesignLine, Party, Cheque, StockLot,
} = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;
let tenantId;
let factory;
let rawMaterial;
let finishedGood;
let vendor;
let customer;
let uom;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-pcm', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@pcm-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'PCM Factory', code: 'PCM-FAC', state: 'Odisha' });

  uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-PCM' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast', gstRatePercent: 18 });
  rawMaterial = await Product.create({ tenantId, uomId: uom.id, name: 'Cement PCM', code: 'RM-PCM', productType: 'RAW_MATERIAL', curingDays: 0, standardCostPaise: 5000 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Slab PCM', code: 'FG-PCM', productType: 'FINISHED_GOOD', curingDays: 0 });

  const mix = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true, status: 'ACTIVE' });
  await MixDesignLine.create({ tenantId, mixDesignId: mix.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 1, uomId: uom.id });

  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'PCM Vendor', state: 'Odisha' });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'PCM Customer', state: 'Odisha' });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@pcm-test.co', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('FR-M11-1 Purchase indent lifecycle', () => {
  let indentId;

  it('raises an indent awaiting approval', async () => {
    const res = await request(app).post('/api/v1/purchasing/indents').set('Cookie', adminCookie).send({
      factoryId: factory.id,
      indentDate: '2026-08-01',
      requiredByDate: '2026-08-20',
      remarks: 'Monsoon stock-up',
      lines: [{ productId: rawMaterial.id, quantity: 500 }],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.status).toBe('PENDING_APPROVAL');
    expect(res.body.data.indentNumber).toMatch(/^IND\//);
    indentId = res.body.data.id;
  });

  it('refuses conversion before approval', async () => {
    const res = await request(app).post(`/api/v1/purchasing/indents/${indentId}/convert`).set('Cookie', adminCookie)
      .send({ vendorPartyId: vendor.id, lineRates: [{ productId: rawMaterial.id, ratePaise: 5000 }] });
    expect(res.status).toBe(400);
  });

  it('approves and converts into a purchase order carrying the indent quantities', async () => {
    const approved = await request(app).put(`/api/v1/purchasing/indents/${indentId}/approve`).set('Cookie', adminCookie);
    expect(approved.status).toBe(200);
    expect(approved.body.data.status).toBe('APPROVED');
    expect(approved.body.data.approvedAt).toBeTruthy();

    const converted = await request(app).post(`/api/v1/purchasing/indents/${indentId}/convert`).set('Cookie', adminCookie)
      .send({ vendorPartyId: vendor.id, orderDate: '2026-08-02', lineRates: [{ productId: rawMaterial.id, ratePaise: 5000 }] });
    expect(converted.status).toBe(201);
    expect(converted.body.data.poNumber).toMatch(/^PO\//);
    expect(Number(converted.body.data.totalAmountPaise)).toBe(2500000); // 500 * 5000

    const reloaded = await request(app).get(`/api/v1/purchasing/indents/${indentId}`).set('Cookie', adminCookie);
    expect(reloaded.body.data.status).toBe('CONVERTED');
  });

  it('refuses a second conversion of the same indent', async () => {
    const res = await request(app).post(`/api/v1/purchasing/indents/${indentId}/convert`).set('Cookie', adminCookie)
      .send({ vendorPartyId: vendor.id, lineRates: [{ productId: rawMaterial.id, ratePaise: 5000 }] });
    expect(res.status).toBe(400);
  });

  it('requires a rate for every line at conversion time', async () => {
    const indent = await request(app).post('/api/v1/purchasing/indents').set('Cookie', adminCookie).send({
      factoryId: factory.id, indentDate: '2026-08-03',
      lines: [{ productId: rawMaterial.id, quantity: 10 }, { productId: finishedGood.id, quantity: 5 }],
    });
    await request(app).put(`/api/v1/purchasing/indents/${indent.body.data.id}/approve`).set('Cookie', adminCookie);

    const res = await request(app).post(`/api/v1/purchasing/indents/${indent.body.data.id}/convert`).set('Cookie', adminCookie)
      .send({ vendorPartyId: vendor.id, lineRates: [{ productId: rawMaterial.id, ratePaise: 5000 }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/rate is required/i);
  });
});

describe('FR-M11-6 Three-way match', () => {
  it('reports a clean match when PO, GRN and invoice agree', async () => {
    const po = await request(app).post('/api/v1/purchasing/orders').set('Cookie', adminCookie).send({
      factoryId: factory.id, vendorPartyId: vendor.id, orderDate: '2026-08-05',
      lines: [{ productId: rawMaterial.id, orderedQty: 100, ratePaise: 5000 }],
    });
    await request(app).put(`/api/v1/purchasing/orders/${po.body.data.id}/confirm`).set('Cookie', adminCookie);

    const grn = await request(app).post('/api/v1/purchasing/receipts').set('Cookie', adminCookie).send({
      factoryId: factory.id, vendorPartyId: vendor.id, purchaseOrderId: po.body.data.id, receiptDate: '2026-08-06',
      lines: [{ productId: rawMaterial.id, receivedQty: 100, ratePaise: 5000 }],
    });

    const invoice = await request(app).post('/api/v1/purchasing/invoices').set('Cookie', adminCookie).send({
      factoryId: factory.id, goodsReceiptId: grn.body.data.id, vendorPartyId: vendor.id,
      vendorInvoiceNumber: 'V-MATCH-1', invoiceDate: '2026-08-06', amountPaise: 500000,
    });

    const match = await request(app)
      .get(`/api/v1/purchasing/invoices/${invoice.body.data.id}/three-way-match`)
      .set('Cookie', adminCookie);
    expect(match.status).toBe(200);
    expect(match.body.data.matched).toBe(true);
    expect(match.body.data.variances).toEqual([]);
  });

  it('flags quantity and invoice-value variances instead of blocking', async () => {
    const po = await request(app).post('/api/v1/purchasing/orders').set('Cookie', adminCookie).send({
      factoryId: factory.id, vendorPartyId: vendor.id, orderDate: '2026-08-07',
      lines: [{ productId: rawMaterial.id, orderedQty: 100, ratePaise: 5000 }],
    });
    await request(app).put(`/api/v1/purchasing/orders/${po.body.data.id}/confirm`).set('Cookie', adminCookie);

    // Short delivery, and the vendor bills more than was accepted.
    const grn = await request(app).post('/api/v1/purchasing/receipts').set('Cookie', adminCookie).send({
      factoryId: factory.id, vendorPartyId: vendor.id, purchaseOrderId: po.body.data.id, receiptDate: '2026-08-08',
      lines: [{ productId: rawMaterial.id, receivedQty: 90, ratePaise: 5000 }],
    });
    const invoice = await request(app).post('/api/v1/purchasing/invoices').set('Cookie', adminCookie).send({
      factoryId: factory.id, goodsReceiptId: grn.body.data.id, vendorPartyId: vendor.id,
      vendorInvoiceNumber: 'V-MATCH-2', invoiceDate: '2026-08-08', amountPaise: 500000,
    });

    const match = await request(app)
      .get(`/api/v1/purchasing/invoices/${invoice.body.data.id}/three-way-match`)
      .set('Cookie', adminCookie);
    expect(match.body.data.matched).toBe(false);

    const types = match.body.data.variances.map((v) => v.type);
    expect(types).toContain('QUANTITY');
    expect(types).toContain('INVOICE_VALUE');
    expect(match.body.data.valueVariancePaise).toBe(50000); // billed 5000 more than accepted
    expect(match.body.data.lines[0].quantityVariance).toBe(-10);
  });
});

describe('FR-M18-7 Cheque lifecycle', () => {
  let receiptId;
  let chequeId;

  it('creates a cheque record when a receipt is taken by cheque', async () => {
    const receipt = await request(app).post('/api/v1/receipts').set('Cookie', adminCookie).send({
      factoryId: factory.id, customerPartyId: customer.id, receiptDate: '2026-08-10',
      modes: [{ mode: 'CHEQUE', amountPaise: 250000, chequeNumber: '000123', bankName: 'SBI', chequeDate: '2026-08-12' }],
    });
    expect(receipt.status).toBe(201);
    receiptId = receipt.body.data.id;

    const cheques = await request(app).get('/api/v1/cheques').set('Cookie', adminCookie);
    expect(cheques.status).toBe(200);
    expect(cheques.body.data.count).toBe(1);

    const cheque = cheques.body.data.rows[0];
    expect(cheque.chequeNumber).toBe('000123');
    expect(cheque.status).toBe('ISSUED');
    expect(cheque.direction).toBe('INBOUND');
    expect(Number(cheque.amountPaise)).toBe(250000);
    chequeId = cheque.id;
  });

  it('enforces the lifecycle order', async () => {
    // Can't clear before presenting.
    const early = await request(app).put(`/api/v1/cheques/${chequeId}/clear`).set('Cookie', adminCookie).send({});
    expect(early.status).toBe(400);

    const presented = await request(app).put(`/api/v1/cheques/${chequeId}/present`).set('Cookie', adminCookie).send({});
    expect(presented.status).toBe(200);
    expect(presented.body.data.status).toBe('PRESENTED');

    const cleared = await request(app).put(`/api/v1/cheques/${chequeId}/clear`).set('Cookie', adminCookie).send({});
    expect(cleared.status).toBe(200);
    expect(cleared.body.data.status).toBe('CLEARED');

    // A cleared cheque is terminal.
    const bounceAfterClear = await request(app).put(`/api/v1/cheques/${chequeId}/bounce`).set('Cookie', adminCookie)
      .send({ reason: 'Too late' });
    expect(bounceAfterClear.status).toBe(400);
  });

  it('a bounce reverses the receipt and books bank charges', async () => {
    const receipt = await request(app).post('/api/v1/receipts').set('Cookie', adminCookie).send({
      factoryId: factory.id, customerPartyId: customer.id, receiptDate: '2026-08-15',
      modes: [{ mode: 'CHEQUE', amountPaise: 100000, chequeNumber: '000999', bankName: 'HDFC', chequeDate: '2026-08-16' }],
    });

    const outstandingAfterReceipt = (
      await request(app).get(`/api/v1/ledger/party/${customer.id}`).set('Cookie', adminCookie)
    ).body.data.outstandingPaise;

    const cheque = await Cheque.findOne({ where: { chequeNumber: '000999' } });
    await request(app).put(`/api/v1/cheques/${cheque.id}/present`).set('Cookie', adminCookie).send({});

    const bounced = await request(app).put(`/api/v1/cheques/${cheque.id}/bounce`).set('Cookie', adminCookie)
      .send({ reason: 'Insufficient funds', bankChargesPaise: 5000 });
    expect(bounced.status).toBe(200);
    expect(bounced.body.data.status).toBe('BOUNCED');

    // The receipt is cancelled and its journal reversed, so the customer owes
    // the money again.
    const reloadedReceipt = await request(app).get(`/api/v1/receipts/${receipt.body.data.id}`).set('Cookie', adminCookie);
    expect(reloadedReceipt.body.data.status).toBe('CANCELLED');

    const outstandingAfterBounce = (
      await request(app).get(`/api/v1/ledger/party/${customer.id}`).set('Cookie', adminCookie)
    ).body.data.outstandingPaise;
    expect(outstandingAfterBounce).toBe(outstandingAfterReceipt + 100000);

    // Bank charges are a real cost and survive separately from the reversal.
    const trial = await request(app).get(`/api/v1/ledger/trial-balance?factoryId=${factory.id}`).set('Cookie', adminCookie);
    const expenseAccount = trial.body.data.find((a) => a.code === '5900');
    expect(expenseAccount.balancePaise).toBe(5000);
  });
});

describe('AC-15 Data migration — opening balances', () => {
  it('rejects opening stock dated at import instead of true production date', async () => {
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const res = await request(app).post('/api/v1/migration/import').set('Cookie', adminCookie).send({
      kind: 'openingStock',
      rows: [{ factoryCode: 'PCM-FAC', productCode: 'RM-PCM', quantity: 10, productionDate: tomorrow.toISOString().slice(0, 10) }],
    });
    expect(res.status).toBe(422);
    expect(JSON.stringify(res.body.data.errors)).toMatch(/ORIGINAL production date/i);
  });

  it('imports nothing at all when any row is invalid (FR-M29-2)', async () => {
    const before = await StockLot.count();

    const res = await request(app).post('/api/v1/migration/import').set('Cookie', adminCookie).send({
      kind: 'openingStock',
      rows: [
        { factoryCode: 'PCM-FAC', productCode: 'RM-PCM', quantity: 10, productionDate: '2026-01-01' },
        { factoryCode: 'PCM-FAC', productCode: 'DOES-NOT-EXIST', quantity: 5, productionDate: '2026-01-01' },
      ],
    });
    expect(res.status).toBe(422);
    expect(await StockLot.count()).toBe(before); // the good row was NOT written
  });

  it('preserves the true production date so old stock is DEAD on day one', async () => {
    const longAgo = new Date();
    longAgo.setDate(longAgo.getDate() - 200);
    const productionDate = longAgo.toISOString().slice(0, 10);

    const res = await request(app).post('/api/v1/migration/import').set('Cookie', adminCookie).send({
      kind: 'openingStock',
      rows: [{ factoryCode: 'PCM-FAC', productCode: 'RM-PCM', quantity: 40, productionDate, lotNumber: 'OPEN-OLD' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.imported).toBe(1);

    const lot = await StockLot.findOne({ where: { lotNumber: 'OPEN-OLD' } });
    // The whole go/no-go criterion: the date is the supplied one, not today.
    expect(lot.originDate).toBe(productionDate);
    expect(Number(lot.qtyAvailable)).toBe(40);

    // And the ageing engine therefore classifies it as DEAD immediately.
    const { AgeingService } = require('../src/api/inventory/ageing.service');
    const cls = require('cls-hooked');
    const { NAMESPACE_NAME } = require('../src/core/tenantContext');
    const session = cls.getNamespace(NAMESPACE_NAME) || cls.createNamespace(NAMESPACE_NAME);
    await session.runAndReturn(() => {
      session.set('tenantId', tenantId);
      return AgeingService.reclassifyAll();
    });

    await lot.reload();
    expect(lot.ageDays).toBeGreaterThanOrEqual(200);
    expect(lot.ageingClass).toBe('DEAD');
  });

  it('a dry run reports what would happen without writing', async () => {
    const before = await StockLot.count();
    const res = await request(app).post('/api/v1/migration/import').set('Cookie', adminCookie).send({
      kind: 'openingStock',
      rows: [{ factoryCode: 'PCM-FAC', productCode: 'RM-PCM', quantity: 7, productionDate: '2026-02-01' }],
      dryRun: true,
    });
    expect(res.status).toBe(200);
    expect(res.body.data.dryRun).toBe(true);
    expect(res.body.data.valid).toBe(true);
    expect(await StockLot.count()).toBe(before);
  });

  it('posts opening party balances through the journal so the books still balance', async () => {
    const res = await request(app).post('/api/v1/migration/import').set('Cookie', adminCookie).send({
      kind: 'openingPartyBalances',
      rows: [{ partyName: 'PCM Customer', balancePaise: 750000, asOfDate: '2026-04-01' }],
    });
    expect(res.status).toBe(200);

    const trial = await request(app).get('/api/v1/ledger/trial-balance').set('Cookie', adminCookie);
    const totalDebit = trial.body.data.reduce((s, a) => s + Number(a.totalDebitPaise), 0);
    const totalCredit = trial.body.data.reduce((s, a) => s + Number(a.totalCreditPaise), 0);
    expect(totalDebit).toBe(totalCredit); // AC-11.1 still holds after migration

    const equity = trial.body.data.find((a) => a.code === '3000');
    expect(equity).toBeTruthy();
  });
});

describe('FR-M27-2/3 Report export', () => {
  it('exports CSV with the title and applied filters', async () => {
    const res = await request(app).post('/api/v1/reports/export').set('Cookie', adminCookie)
      .send({ reportType: 'TRIAL_BALANCE', params: { factoryId: factory.id }, format: 'csv' });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="trial_balance-/);
    expect(res.text).toContain('Trial Balance');
    expect(res.text).toContain('Filters:');
    expect(res.text).toContain('Debit');
  });

  it('omits value COLUMNS entirely for a user without VIEW_RATES (FR-M27-3)', async () => {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const { AdGroup, AdGroupMember } = require('../src/models/index');
    const { WebPermissions } = require('../src/utils/constants');

    const clerk = await User.create(
      { tenantId, email: 'clerk@pcm-test.co', passwordHash, firstName: 'Clerk', lastName: 'User', role: 'EMPLOYEE' },
      { validate: false }
    );
    const group = await AdGroup.create({ tenantId, name: 'Report Reader', permissions: [WebPermissions.REPORT_READ] });
    await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: clerk.id });
    const clerkCookie = extractCookie(
      await request(app).post('/api/v1/auth/login').send({ email: 'clerk@pcm-test.co', password: PASSWORD }),
      'accessToken'
    );

    const res = await request(app).post('/api/v1/reports/export').set('Cookie', clerkCookie)
      .send({ reportType: 'TRIAL_BALANCE', params: { factoryId: factory.id }, format: 'csv' });

    expect(res.status).toBe(200);
    const header = res.text.split('\n').find((l) => l.startsWith('Code'));
    // Non-money columns survive...
    expect(header).toContain('Account');
    // ...and the money columns are gone from the header row entirely, rather
    // than present with empty cells underneath.
    expect(header).not.toContain('Debit');
    expect(header).not.toContain('Credit');
    expect(header).not.toContain('Balance');
    expect(res.text).toContain('not included for your role');
  });

  it('exports a PDF', async () => {
    const res = await request(app).post('/api/v1/reports/export').set('Cookie', adminCookie)
      .send({ reportType: 'TRIAL_BALANCE', params: { factoryId: factory.id }, format: 'pdf' })
      .buffer(true)
      .parse((r, cb) => {
        const chunks = [];
        r.on('data', (c) => chunks.push(c));
        r.on('end', () => cb(null, Buffer.concat(chunks)));
      });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
  });
});
