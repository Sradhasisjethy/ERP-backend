const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, MixDesign, MixDesignLine, Party, LabourWageProfile, PriceList, PriceListItem,
} = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;
let factory;
let rawMaterial;
let finishedGood;
let vendor;
let contractor;
let labour;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-workforce', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@workforce-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Workforce Factory', code: 'WF-FAC' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-WF' });
  rawMaterial = await Product.create({ tenantId, uomId: uom.id, name: 'Cement WF', code: 'RM-CEMENT-WF', productType: 'RAW_MATERIAL', curingDays: 0 });
  finishedGood = await Product.create({ tenantId, uomId: uom.id, name: 'Precast Slab WF', code: 'FG-SLAB-WF', productType: 'FINISHED_GOOD', curingDays: 0 });

  const mixDesign = await MixDesign.create({ tenantId, productId: finishedGood.id, name: 'Mix v1', version: 1, isActive: true });
  await MixDesignLine.create({ tenantId, mixDesignId: mixDesign.id, rawMaterialProductId: rawMaterial.id, quantityPerUnit: 2, uomId: uom.id });

  vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'WF Vendor' });
  contractor = await Party.create({ tenantId, partyType: 'CONTRACTOR', name: 'WF Contractor' });
  labour = await Party.create({ tenantId, partyType: 'LABOUR', name: 'WF Labourer' });
  await LabourWageProfile.create({ tenantId, partyId: labour.id, dailyWagePaise: 60000, overtimeRateMultiplier: 1.5 });

  const priceList = await PriceList.create({ tenantId, name: 'Contractor Rates', priceType: 'CONTRACTOR_RATE', partyId: contractor.id });
  await PriceListItem.create({ tenantId, priceListId: priceList.id, productId: finishedGood.id, ratePaise: 20000 });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@workforce-test.co', password: PASSWORD }), 'accessToken');

  // Stock the factory with raw material so it can be issued to the contractor.
  await request(app)
    .post('/api/v1/purchasing/receipts')
    .set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-08-10', lines: [{ productId: rawMaterial.id, receivedQty: 500, ratePaise: 5000 }] });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Contractor job-work (M26, BR-22, BR-23)', () => {
  it('issuing material moves it into a WITH_CONTRACTOR lot, leaving normal stock', async () => {
    const before = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${rawMaterial.id}`).set('Cookie', adminCookie);

    const res = await request(app)
      .post('/api/v1/workforce/contractor/material-issues')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, contractorPartyId: contractor.id, issueDate: '2026-08-18', lines: [{ productId: rawMaterial.id, quantity: 40 }] });
    expect(res.status).toBe(201);

    const after = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${rawMaterial.id}`).set('Cookie', adminCookie);
    expect(after.body.data.balance).toBe(before.body.data.balance - 40); // AVAILABLE balance excludes WITH_CONTRACTOR

    const withContractorLots = await request(app)
      .get(`/api/v1/inventory/lots?factoryId=${factory.id}&productId=${rawMaterial.id}&status=WITH_CONTRACTOR`)
      .set('Cookie', adminCookie);
    expect(Number(withContractorLots.body.data.rows[0].qtyAvailable)).toBe(40);
  });

  it('all-or-none: production entry creates finished stock, consumes WITH_CONTRACTOR material, and credits the contractor ledger', async () => {
    const outstandingBefore = await request(app).get(`/api/v1/ledger/party/${contractor.id}`).set('Cookie', adminCookie);
    const finishedBefore = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${finishedGood.id}`).set('Cookie', adminCookie);

    const res = await request(app)
      .post('/api/v1/workforce/contractor/production-entries')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, contractorPartyId: contractor.id, productId: finishedGood.id, productionDate: '2026-08-19', quantity: 10 });
    expect(res.status).toBe(201);
    expect(Number(res.body.data.pieceRatePaise)).toBe(20000); // resolved from the CONTRACTOR_RATE price list
    expect(Number(res.body.data.totalValuePaise)).toBe(200000); // 10 * 20000

    const finishedAfter = await request(app).get(`/api/v1/inventory/balance?factoryId=${factory.id}&productId=${finishedGood.id}`).set('Cookie', adminCookie);
    expect(finishedAfter.body.data.balance).toBe(finishedBefore.body.data.balance + 10); // curingDays=0 => AVAILABLE immediately

    const withContractorLots = await request(app)
      .get(`/api/v1/inventory/lots?factoryId=${factory.id}&productId=${rawMaterial.id}&status=WITH_CONTRACTOR`)
      .set('Cookie', adminCookie);
    expect(Number(withContractorLots.body.data.rows[0].qtyAvailable)).toBe(20); // 40 issued - (2/unit * 10 units)

    // AP-side party: crediting what we owe them makes outstanding (debit -
    // credit) more negative, not more positive — see ledger.service.js's
    // getPartyOutstanding docstring.
    const outstandingAfter = await request(app).get(`/api/v1/ledger/party/${contractor.id}`).set('Cookie', adminCookie);
    // Payables now read positive on a statement, matching the payables report
    // and the way the number is spoken about ("we owe them X"). The ledger
    // endpoint used to return debit − credit for every party type, which
    // negated every vendor, contractor and labour balance. See
    // FINANCE_ACCOUNTS_AUDIT.md §"Party statement sign".
    // Job work earned by the contractor increases what we owe them.
    expect(outstandingAfter.body.data.outstandingPaise).toBe(outstandingBefore.body.data.outstandingPaise + 200000);
  });

  it('rejects a contractor entry with no configured piece rate', async () => {
    const otherContractor = await Party.create({ tenantId: factory.tenantId, partyType: 'CONTRACTOR', name: 'No Rate Contractor' });
    const res = await request(app)
      .post('/api/v1/workforce/contractor/production-entries')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, contractorPartyId: otherContractor.id, productId: finishedGood.id, productionDate: '2026-08-19', quantity: 5 });
    expect(res.status).toBe(400);
  });
});

describe('Labour attendance & wages (M27, BR-24)', () => {
  it('PRESENT accrues the full daily wage', async () => {
    const outstandingBefore = await request(app).get(`/api/v1/ledger/party/${labour.id}`).set('Cookie', adminCookie);
    const res = await request(app)
      .post('/api/v1/workforce/labour/attendance')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, labourPartyId: labour.id, attendanceDate: '2026-08-20', status: 'PRESENT' });
    expect(res.status).toBe(201);
    expect(Number(res.body.data.wageAccruedPaise)).toBe(60000);

    // AP-side party — see the contractor test above for why this is a subtraction.
    const outstandingAfter = await request(app).get(`/api/v1/ledger/party/${labour.id}`).set('Cookie', adminCookie);
    // A day's wage accrued increases what we owe the labourer.
    expect(outstandingAfter.body.data.outstandingPaise).toBe(outstandingBefore.body.data.outstandingPaise + 60000);
  });

  it('HALF_DAY accrues 50%', async () => {
    const res = await request(app)
      .post('/api/v1/workforce/labour/attendance')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, labourPartyId: labour.id, attendanceDate: '2026-08-21', status: 'HALF_DAY' });
    expect(Number(res.body.data.wageAccruedPaise)).toBe(30000);
  });

  it('OVERTIME accrues the full day plus the configured overtime rate', async () => {
    const res = await request(app)
      .post('/api/v1/workforce/labour/attendance')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, labourPartyId: labour.id, attendanceDate: '2026-08-22', status: 'OVERTIME', overtimeHours: 4 });
    // dailyWage 60000 + (60000/8 hourly=7500) * 4h * 1.5x = 60000 + 45000 = 105000
    expect(Number(res.body.data.wageAccruedPaise)).toBe(105000);
  });

  it('rejects a duplicate attendance record for the same labourer and date', async () => {
    const res = await request(app)
      .post('/api/v1/workforce/labour/attendance')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, labourPartyId: labour.id, attendanceDate: '2026-08-20', status: 'PRESENT' });
    expect(res.status).toBe(409);
  });
});

describe('Advances (BR-25)', () => {
  it('an advance debits the party AP account, reducing net outstanding, and can be cancelled', async () => {
    const outstandingBefore = await request(app).get(`/api/v1/ledger/party/${labour.id}`).set('Cookie', adminCookie);

    // mode: BANK — the factory's CASH account was never funded in this test
    // (BR-21 correctly blocks a cash advance against a zero/negative cash
    // balance by default), so this exercises the advance mechanics via bank instead.
    const advance = await request(app)
      .post('/api/v1/workforce/advances')
      .set('Cookie', adminCookie)
      .send({ factoryId: factory.id, partyId: labour.id, advanceDate: '2026-08-23', mode: 'BANK', amountPaise: 20000, reason: 'Festival advance' });
    expect(advance.status).toBe(201);

    // An advance *debits* AP, moving the (negative, AP-side) outstanding
    // balance up toward zero — i.e. it reduces what we owe them.
    const outstandingAfterAdvance = await request(app).get(`/api/v1/ledger/party/${labour.id}`).set('Cookie', adminCookie);
    // An advance is money already paid out, so it reduces what is still owed.
    expect(outstandingAfterAdvance.body.data.outstandingPaise).toBe(outstandingBefore.body.data.outstandingPaise - 20000);

    const cancelled = await request(app).put(`/api/v1/workforce/advances/${advance.body.data.id}/cancel`).set('Cookie', adminCookie).send({ reason: 'Entered twice' });
    expect(cancelled.status).toBe(200);

    const outstandingAfterCancel = await request(app).get(`/api/v1/ledger/party/${labour.id}`).set('Cookie', adminCookie);
    expect(outstandingAfterCancel.body.data.outstandingPaise).toBe(outstandingBefore.body.data.outstandingPaise);
  });
});
