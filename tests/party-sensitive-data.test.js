/**
 * Party identity and bank details (findings D2 and D3).
 *
 * PARTY_READ — held by store keepers, sales, purchase and accountants — used to
 * return every labourer's Aadhaar and bank account, and every include of a
 * party on an order or expense carried them too. Audit snapshots kept full
 * copies for anyone with AUDIT_READ. Synthetic numbers only.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { AuditLog } = require('../src/api/audit/auditLog.model');
const { Expense } = require('../src/api/expenses/expense.model');
const { permissionsForSystemRole } = require('../src/utils/systemRolePermissions');
const {
  Tenant, User, Organization, Factory, FinancialYear, Party, AdGroup, AdGroupMember, UserFactory,
} = require('../src/models/index');

const PASSWORD = 'password123';
const AADHAAR = '999900001111';
const ACCOUNT = '000111222333';

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

let T;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const tenant = await Tenant.create({ name: 'Pii Co', slug: 'pii-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Pii Pvt Ltd', code: 'PII' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'ACTIVE' });
  const factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant', code: 'PL', state: 'Odisha' });

  const mk = (email) =>
    User.create({ tenantId, email, passwordHash, firstName: 'F', lastName: 'L', role: 'EMPLOYEE', status: 'ACTIVE' }, { validate: false });
  const grant = async (user, name, permissions) => {
    const group = await AdGroup.create({ tenantId, name, permissions, status: 'active' });
    await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });
  };

  const reader = await mk('reader@pii.test');
  await grant(reader, 'Party readers', ['PARTY_READ']);
  const editor = await mk('editor@pii.test');
  await grant(editor, 'Party editors', ['PARTY_READ', 'PARTY_CREATE', 'PARTY_MODIFY']);
  const trusted = await mk('trusted@pii.test');
  // Changing identity details now needs PARTY_SENSITIVE_MODIFY as well.
  await grant(trusted, 'Payroll', ['PARTY_READ', 'PARTY_MODIFY', 'PARTY_SENSITIVE_READ', 'PARTY_SENSITIVE_MODIFY']);
  const accountant = await mk('accounts@pii.test');
  await grant(accountant, 'Expense readers', ['EXPENSE_READ']);
  await UserFactory.create({ tenantId, userId: accountant.id, factoryId: factory.id });
  const auditor = await mk('auditor@pii.test');
  await grant(auditor, 'Auditors', ['AUDIT_READ']);

  const labour = await Party.create({
    tenantId, partyType: 'LABOUR', name: 'Test Worker', code: 'LAB-0001',
    aadhaarNumber: AADHAAR, bankAccountNumber: ACCOUNT, bankIfsc: 'TEST0000999', pan: 'ABCDE1234F', dateOfBirth: '1990-05-15',
  });
  const expense = await Expense.create({
    tenantId, factoryId: factory.id, expenseNumber: 'EXP-0001', expenseDate: '2026-10-01',
    category: 'Labour', mode: 'CASH', amountPaise: 10000, paidToPartyId: labour.id,
  });

  T = { tenantId, labour, expense };
  T.reader = await loginAs('reader@pii.test');
  T.editor = await loginAs('editor@pii.test');
  T.trusted = await loginAs('trusted@pii.test');
  T.accountant = await loginAs('accounts@pii.test');
  T.auditor = await loginAs('auditor@pii.test');
});

afterAll(async () => {
  await sequelize.close();
});

describe('D2: identity and bank details need PARTY_SENSITIVE_READ', () => {
  it('masks them to the last four for a PARTY_READ-only user', async () => {
    const res = await request(app).get(`/api/v1/parties/${T.labour.id}`).set('Cookie', T.reader);
    expect(res.status).toBe(200);
    const body = JSON.stringify(res.body);
    expect(body).toContain('1111');
    expect(body).not.toContain(AADHAAR);
    expect(body).not.toContain(ACCOUNT);
    expect(res.body.data.aadhaarNumber).toBe('••••••••1111');
    // The last four of a date is the birthday — hidden whole.
    expect(res.body.data.dateOfBirth).toBe('••••••••');
  });

  it('masks the list too, and does not let the search box confirm an Aadhaar', async () => {
    const list = await request(app).get('/api/v1/parties').set('Cookie', T.reader);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).not.toContain(AADHAAR);

    const search = await request(app).get('/api/v1/parties').query({ search: AADHAAR }).set('Cookie', T.reader);
    expect(search.status).toBe(200);
    expect(search.body.data.rows).toHaveLength(0);
  });

  it('returns full values to a user who also holds PARTY_SENSITIVE_READ', async () => {
    const res = await request(app).get(`/api/v1/parties/${T.labour.id}`).set('Cookie', T.trusted);
    expect(res.status).toBe(200);
    expect(res.body.data.aadhaarNumber).toBe(AADHAAR);
    expect(res.body.data.bankAccountNumber).toBe(ACCOUNT);
    expect(res.body.data.dateOfBirth).toBe('1990-05-15');
  });

  it('does not carry them on a party included in another module\'s record', async () => {
    const res = await request(app).get(`/api/v1/expenses/${T.expense.id}`).set('Cookie', T.accountant);
    expect(res.status).toBe(200);
    expect(res.body.data.paidToParty.name).toBe('Test Worker');
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(AADHAAR);
    expect(body).not.toContain(ACCOUNT);
    expect(res.body.data.paidToParty).not.toHaveProperty('aadhaarNumber');
  });

  it('keeps the real values when the edit form sends the masked ones back', async () => {
    const shown = await request(app).get(`/api/v1/parties/${T.labour.id}`).set('Cookie', T.editor);
    const res = await request(app)
      .put(`/api/v1/parties/${T.labour.id}`)
      .set('Cookie', T.editor)
      .send({
        name: 'Test Worker Renamed',
        aadhaarNumber: shown.body.data.aadhaarNumber,
        bankAccountNumber: shown.body.data.bankAccountNumber,
        dateOfBirth: shown.body.data.dateOfBirth,
      });
    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(AADHAAR);

    const stored = await Party.scope('withSensitive').findByPk(T.labour.id);
    expect(stored.name).toBe('Test Worker Renamed');
    expect(stored.aadhaarNumber).toBe(AADHAAR);
    expect(stored.bankAccountNumber).toBe(ACCOUNT);
    expect(stored.dateOfBirth).toBe('1990-05-15');
  });

  it('never gives ORG_ADMIN the grant by job title', () => {
    expect(permissionsForSystemRole('ORG_ADMIN')).toContain('PARTY_READ');
    expect(permissionsForSystemRole('ORG_ADMIN')).not.toContain('PARTY_SENSITIVE_READ');
  });
});

describe('D3: audit snapshots do not keep the values', () => {
  it('records a party change without the identity or bank details', async () => {
    const res = await request(app)
      .put(`/api/v1/parties/${T.labour.id}`)
      .set('Cookie', T.trusted)
      .send({ name: 'Test Worker Audited', aadhaarNumber: '999900002222' });
    expect(res.status).toBe(200);

    const rows = await AuditLog.findAll({ where: { entityType: 'Party', entityId: T.labour.id } });
    expect(rows.length).toBeGreaterThan(0);
    const snapshots = JSON.stringify(rows.map((row) => [row.beforeSnapshot, row.afterSnapshot]));
    expect(snapshots).toContain('Test Worker Audited');
    expect(snapshots).not.toContain('99990000');
    expect(snapshots).not.toContain(ACCOUNT);

    const viaApi = await request(app).get('/api/v1/audit-logs').query({ entityType: 'Party' }).set('Cookie', T.auditor);
    expect(viaApi.status).toBe(200);
    expect(JSON.stringify(viaApi.body)).not.toContain('99990000');
  });
});
