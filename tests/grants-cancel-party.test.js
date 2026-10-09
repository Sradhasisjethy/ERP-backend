/**
 * Regression tests for the access-control decisions of 2026-10-09:
 *   A8  cancelling a posted document is a named <DOC>_CANCEL grant, not *_MODIFY
 *   A7  posting a purchase invoice needs PURCHASE_INVOICE_CREATE, not PURCHASE_CREATE
 *   A2  credit terms, bank/identity/commission details and wages need their own grants
 *   A11 HR_ADMIN no longer deletes users by job title
 * Each refused request here succeeded before the fix.
 */
const crypto = require('crypto');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Party } = require('../src/api/parties/party.model');
const { PartiesService } = require('../src/api/parties/parties.service');
const { DEFAULT_ROLES } = require('../src/constants/defaultRoles');
const { permissionsForSystemRole } = require('../src/utils/systemRolePermissions');
const { expandPermissions } = require('../src/utils/permissionCatalog');
const {
  Tenant, User, Organization, Factory, FinancialYear, AdGroup, AdGroupMember, UserFactory,
} = require('../src/models/index');

const PASSWORD = 'password123';
const ACCOUNT = '111122223333';

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

const fakeId = () => crypto.randomUUID();
let T;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const tenant = await Tenant.create({ name: 'Grants Co', slug: 'grants-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Grants Pvt Ltd', code: 'GC' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'ACTIVE' });
  const factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant', code: 'PL', state: 'Odisha' });

  // One dummy user per permission set, in an AdGroup with explicit codes.
  const users = {
    editor: ['INVOICE_READ', 'INVOICE_MODIFY', 'DISPATCH_READ', 'DISPATCH_MODIFY', 'PAYMENT_READ', 'PAYMENT_MODIFY'],
    canceller: ['INVOICE_READ', 'INVOICE_CANCEL', 'DISPATCH_READ', 'DISPATCH_CANCEL', 'PAYMENT_READ', 'PAYMENT_CANCEL'],
    stores: ['PURCHASE_READ', 'PURCHASE_CREATE'],
    billing: ['PURCHASE_READ', 'PURCHASE_INVOICE_CREATE'],
    sales: ['PARTY_READ', 'PARTY_CREATE', 'PARTY_MODIFY'],
    trusted: ['PARTY_READ', 'PARTY_MODIFY', 'PARTY_SENSITIVE_MODIFY', 'LABOUR_MODIFY'],
  };
  for (const [key, permissions] of Object.entries(users)) {
    const user = await User.create(
      { tenantId, email: `${key}@grants.test`, passwordHash, firstName: key, lastName: 'L', role: 'EMPLOYEE', status: 'ACTIVE' },
      { validate: false }
    );
    const group = await AdGroup.create({ tenantId, name: `G ${key}`, permissions, status: 'active' });
    await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });
    await UserFactory.create({ tenantId, userId: user.id, factoryId: factory.id });
  }

  const blockedCustomer = await Party.create({
    tenantId, partyType: 'CUSTOMER', name: 'Blocked Builders', code: 'CUST-B', creditLimitPaise: 5000000, creditAction: 'BLOCK',
  });
  const vendor = await Party.create({
    tenantId, partyType: 'VENDOR', name: 'Bank Vendor', code: 'VEND-B', bankAccountNumber: ACCOUNT, bankIfsc: 'TEST0000999',
  });
  const labour = await Party.create({ tenantId, partyType: 'LABOUR', name: 'Wage Worker', code: 'LAB-W' });

  T = { tenantId, blockedCustomer, vendor, labour };
  for (const key of Object.keys(users)) T[key] = await loginAs(`${key}@grants.test`);
});

afterAll(async () => {
  await sequelize.close();
});

describe('A8: cancelling a posted document is a named grant', () => {
  it('refuses an invoice cancel to INVOICE_MODIFY without INVOICE_CANCEL', async () => {
    const res = await request(app).put(`/api/v1/invoices/${fakeId()}/cancel`).set('Cookie', T.editor).send({ reason: 'Duplicate bill' });
    expect(res.status).toBe(403);
  });

  it('lets INVOICE_CANCEL past the gate', async () => {
    const res = await request(app).put(`/api/v1/invoices/${fakeId()}/cancel`).set('Cookie', T.canceller).send({ reason: 'Duplicate bill' });
    expect([400, 404]).toContain(res.status);
  });

  it('gates the counter-sale cancel on INVOICE_CANCEL too', async () => {
    const refused = await request(app).post(`/api/v1/retail/counter-sales/${fakeId()}/cancel`).set('Cookie', T.editor).send({ reason: 'Wrong item' });
    expect(refused.status).toBe(403);
    const passed = await request(app).post(`/api/v1/retail/counter-sales/${fakeId()}/cancel`).set('Cookie', T.canceller).send({ reason: 'Wrong item' });
    expect(passed.status).not.toBe(403);
  });

  it('refuses a challan cancel to DISPATCH_MODIFY alone', async () => {
    const res = await request(app).put(`/api/v1/dispatch/challans/${fakeId()}/cancel`).set('Cookie', T.editor).send({ reason: 'Truck broke down' });
    expect(res.status).toBe(403);
  });

  it('moves only the cheque cancel to PAYMENT_CANCEL; presenting stays on PAYMENT_MODIFY', async () => {
    const cancel = await request(app).put(`/api/v1/cheques/${fakeId()}/cancel`).set('Cookie', T.editor).send({ reason: 'Lost cheque' });
    expect(cancel.status).toBe(403);
    const present = await request(app).put(`/api/v1/cheques/${fakeId()}/present`).set('Cookie', T.editor)
      .send({ presentedAt: new Date().toISOString() });
    expect(present.status).not.toBe(403);
  });

  it('is never implied by a legacy _WRITE code or a system role', () => {
    const fromWrite = expandPermissions(['INVOICE_WRITE', 'PAYMENT_WRITE', 'DISPATCH_WRITE', 'RETURN_WRITE', 'JOURNAL_WRITE']);
    ['INVOICE_CANCEL', 'PAYMENT_CANCEL', 'DISPATCH_CANCEL', 'RETURN_CANCEL', 'JOURNAL_CANCEL'].forEach((code) => {
      expect(fromWrite).not.toContain(code);
    });
    expect(permissionsForSystemRole('ORG_ADMIN')).not.toContain('INVOICE_CANCEL');
    expect(permissionsForSystemRole('ORG_ADMIN')).not.toContain('PARTY_SENSITIVE_MODIFY');
  });
});

describe('A7: posting a purchase invoice is its own grant', () => {
  it('refuses PURCHASE_CREATE alone', async () => {
    const res = await request(app).post('/api/v1/purchasing/invoices').set('Cookie', T.stores).send({});
    expect(res.status).toBe(403);
  });

  it('lets PURCHASE_INVOICE_CREATE past the gate', async () => {
    const res = await request(app).post('/api/v1/purchasing/invoices').set('Cookie', T.billing).send({});
    expect(res.status).toBe(400);
  });
});

describe('A2: party fields that need more than PARTY_MODIFY', () => {
  it('refuses loosening a blocked customer without SALES_CREDIT_OVERRIDE', async () => {
    const res = await request(app).put(`/api/v1/parties/${T.blockedCustomer.id}`).set('Cookie', T.sales).send({ creditAction: 'NONE' });
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('Credit override');
    expect((await Party.findByPk(T.blockedCustomer.id)).creditAction).toBe('BLOCK');
  });

  it('accepts the edit form re-sending the same credit terms', async () => {
    const res = await request(app).put(`/api/v1/parties/${T.blockedCustomer.id}`).set('Cookie', T.sales)
      .send({ name: 'Blocked Builders Ltd', creditAction: 'BLOCK', creditLimitPaise: 5000000 });
    expect(res.status).toBe(200);
  });

  it('refuses changing a bank account without PARTY_SENSITIVE_MODIFY', async () => {
    const res = await request(app).put(`/api/v1/parties/${T.vendor.id}`).set('Cookie', T.sales).send({ bankAccountNumber: '999' });
    expect(res.status).toBe(403);
    expect((await Party.scope('withSensitive').findByPk(T.vendor.id)).bankAccountNumber).toBe(ACCOUNT);
  });

  it('still accepts the masked value the form was shown', async () => {
    const shown = await request(app).get(`/api/v1/parties/${T.vendor.id}`).set('Cookie', T.sales);
    const res = await request(app).put(`/api/v1/parties/${T.vendor.id}`).set('Cookie', T.sales)
      .send({ name: 'Bank Vendor Renamed', bankAccountNumber: shown.body.data.bankAccountNumber });
    expect(res.status).toBe(200);
  });

  it('lets a PARTY_SENSITIVE_MODIFY holder change it', async () => {
    const res = await request(app).put(`/api/v1/parties/${T.vendor.id}`).set('Cookie', T.trusted).send({ bankAccountNumber: '444455556666' });
    expect(res.status).toBe(200);
  });

  it('allows bank details on a new vendor for a PARTY_CREATE holder', async () => {
    const res = await request(app).post('/api/v1/parties').set('Cookie', T.sales).send({
      partyType: 'VENDOR', name: 'New Vendor', bankAccountNumber: '777788889999', bankIfsc: 'TEST0000111', creditAgeingDays: 30,
    });
    expect(res.status).toBe(201);
  });

  it('refuses a new customer born with a credit block without the override', async () => {
    const res = await request(app).post('/api/v1/parties').set('Cookie', T.sales)
      .send({ partyType: 'CUSTOMER', name: 'Pre-blocked', creditAction: 'BLOCK', creditLimitPaise: 100 });
    expect(res.status).toBe(403);
  });

  it('refuses a wage profile without LABOUR_MODIFY, and allows re-sending it unchanged', async () => {
    const refused = await request(app).put(`/api/v1/parties/${T.labour.id}/wage-profile`).set('Cookie', T.sales).send({ dailyWagePaise: 60000 });
    expect(refused.status).toBe(403);

    const set = await request(app).put(`/api/v1/parties/${T.labour.id}/wage-profile`).set('Cookie', T.trusted).send({ dailyWagePaise: 60000 });
    expect(set.status).toBe(200);

    const resent = await request(app).put(`/api/v1/parties/${T.labour.id}/wage-profile`).set('Cookie', T.sales)
      .send({ dailyWagePaise: 60000, overtimeRateMultiplier: 1.5 });
    expect(resent.status).toBe(200);
  });

  it('refuses a guarded change when no actor can be established', async () => {
    await expect(PartiesService.updateParty(T.blockedCustomer.id, { creditAction: 'NONE' })).rejects.toMatchObject({ statusCode: 403 });
  });
});

describe('A11 and the default roles', () => {
  it('no longer lets HR_ADMIN delete users', () => {
    const hr = expandPermissions(permissionsForSystemRole('HR_ADMIN'));
    expect(hr).toEqual(expect.arrayContaining(['EMPLOYEE_READ', 'EMPLOYEE_CREATE', 'EMPLOYEE_MODIFY']));
    expect(hr).not.toContain('EMPLOYEE_DELETE');
  });

  it('gives the Accountant the cancels and the purchase-invoice grant, and not the Store Keeper', () => {
    const role = (name) => DEFAULT_ROLES.find((r) => r.name === name).permissions;
    expect(role('Accountant')).toEqual(expect.arrayContaining(['INVOICE_CANCEL', 'PURCHASE_INVOICE_CREATE', 'PARTY_SENSITIVE_MODIFY']));
    expect(role('Purchase Officer')).toContain('PURCHASE_INVOICE_CREATE');
    expect(role('Store Keeper')).not.toContain('PURCHASE_INVOICE_CREATE');
    expect(role('Sales Executive')).toContain('DISPATCH_CANCEL');
  });
});
