const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Party,
  AdGroup, AdGroupMember, UserFactory, AuditLog,
} = require('../src/models/index');

/**
 * Organisation- and factory-level access scope, end to end.
 *
 * The structure under test mirrors the brief exactly:
 *
 *   Tenant "Isolation Co"
 *     Organisation One  — Plant A, Plant B
 *     Organisation Two  — Plant C
 *
 * A user assigned to Organisation One -> Plant A must see and touch only
 * Plant A's data; a plant-scoped administrator must only be able to hand out
 * plants within their own scope and organisation; and moving a user between
 * plants must end their old sessions. factory-record-scope.test.js covers the
 * per-module record guards; this file covers the assignment machinery, the
 * factory list the dropdowns are built from, and request tampering.
 */

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

const as = (cookie) => ({
  get: (p) => request(app).get(p).set('Cookie', cookie),
  post: (p, b) => request(app).post(p).set('Cookie', cookie).send(b || {}),
  put: (p, b) => request(app).put(p).set('Cookie', cookie).send(b || {}),
  del: (p) => request(app).delete(p).set('Cookie', cookie),
});

let X; // shared fixtures
let owner; // TENANT_OWNER cookie (unrestricted)
let plantAUser; // ordinary user scoped to Org One -> Plant A
let hrAdminA; // administrator scoped to Org One -> Plant A

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Isolation Co', slug: 'isolation-co', status: 'active' });
  const tenantId = tenant.id;
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });

  const orgOne = await Organization.create({ tenantId, name: 'Organisation One', code: 'ORG1' });
  const orgTwo = await Organization.create({ tenantId, name: 'Organisation Two', code: 'ORG2' });
  const plantA = await Factory.create({ tenantId, organizationId: orgOne.id, name: 'Plant A', code: 'PA' });
  const plantB = await Factory.create({ tenantId, organizationId: orgOne.id, name: 'Plant B', code: 'PB' });
  const plantC = await Factory.create({ tenantId, organizationId: orgTwo.id, name: 'Plant C', code: 'PC' });
  const vendor = await Party.create({ tenantId, partyType: 'VENDOR', name: 'Isolation Vendor' });

  await User.create(
    { tenantId, email: 'owner@isolation.test', passwordHash, firstName: 'Owner', lastName: 'One', role: 'TENANT_OWNER', status: 'ACTIVE' },
    { validate: false }
  );

  const staff = await AdGroup.create({
    tenantId,
    name: 'Plant staff',
    permissions: ['EXPENSE_READ', 'EXPENSE_CREATE', 'EXPENSE_MODIFY', 'FACTORY_READ'],
  });
  const aUser = await User.create(
    { tenantId, email: 'planta@isolation.test', passwordHash, firstName: 'Plant', lastName: 'A', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: orgOne.id },
    { validate: false }
  );
  await AdGroupMember.create({ tenantId, adGroupId: staff.id, employeeId: aUser.id });
  await UserFactory.create({ tenantId, userId: aUser.id, factoryId: plantA.id });

  const admins = await AdGroup.create({
    tenantId,
    name: 'Plant A administration',
    permissions: [
      'EMPLOYEE_READ', 'EMPLOYEE_CREATE', 'EMPLOYEE_MODIFY',
      'FACTORY_READ', 'FACTORY_CREATE', 'FACTORY_MODIFY', 'FACTORY_DELETE',
    ],
  });
  const adminUser = await User.create(
    { tenantId, email: 'hradmin@isolation.test', passwordHash, firstName: 'HR', lastName: 'AdminA', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: orgOne.id },
    { validate: false }
  );
  await AdGroupMember.create({ tenantId, adGroupId: admins.id, employeeId: adminUser.id });
  await UserFactory.create({ tenantId, userId: adminUser.id, factoryId: plantA.id });

  owner = await loginAs('owner@isolation.test');
  plantAUser = await loginAs('planta@isolation.test');
  hrAdminA = await loginAs('hradmin@isolation.test');

  // One expense per plant, created through the real API by the unrestricted
  // owner, so every downstream check exercises production code paths.
  const createExpense = async (factory, tag) => {
    const res = await as(owner).post('/api/v1/expenses', {
      factoryId: factory.id, expenseDate: '2026-08-20', category: `Diesel-${tag}`, mode: 'BANK',
      amountPaise: 10000, paidToPartyId: vendor.id, description: `Diesel at ${tag}`,
    });
    expect(res.status).toBe(201);
    return res.body.data;
  };

  X = { tenantId, orgOne, orgTwo, plantA, plantB, plantC, vendor, aUser, adminUser };
  X.expenseA = await createExpense(plantA, 'A');
  X.expenseB = await createExpense(plantB, 'B');
  X.expenseC = await createExpense(plantC, 'C');
});

afterAll(async () => {
  await sequelize.close();
});

describe('A/G — read isolation on lists, counts and pagination', () => {
  it('lists only the assigned plant\'s records, and the count agrees', async () => {
    const res = await as(plantAUser).get('/api/v1/expenses');
    expect(res.status).toBe(200);
    const { rows, count } = res.body.data;
    expect(rows).toHaveLength(1);
    expect(rows[0].factoryId).toBe(X.plantA.id);
    // The paginated count is an aggregate; it must not leak the other plants.
    expect(count).toBe(1);
  });

  it('an unrestricted owner still sees every plant (role regression, I)', async () => {
    const res = await as(owner).get('/api/v1/expenses');
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBe(3);
  });
});

describe('B/D — direct object access by id', () => {
  it('404s another plant\'s record in the same organisation, and one in another organisation', async () => {
    expect((await as(plantAUser).get(`/api/v1/expenses/${X.expenseB.id}`)).status).toBe(404);
    expect((await as(plantAUser).get(`/api/v1/expenses/${X.expenseC.id}`)).status).toBe(404);
  });

  it('refuses update/cancel of another plant\'s record and leaves it untouched', async () => {
    const res = await as(plantAUser).put(`/api/v1/expenses/${X.expenseB.id}/cancel`, { reason: 'Not mine to cancel' });
    expect(res.status).toBe(404);
    const fresh = await as(owner).get(`/api/v1/expenses/${X.expenseB.id}`);
    expect(fresh.body.data.status).not.toBe('CANCELLED');
  });

  it('still serves and acts on the caller\'s own record', async () => {
    const got = await as(plantAUser).get(`/api/v1/expenses/${X.expenseA.id}`);
    expect(got.status).toBe(200);
    expect(got.body.data.id).toBe(X.expenseA.id);
  });
});

describe('C/E — request tampering cannot widen scope', () => {
  it('refuses a create naming another plant in the body', async () => {
    const res = await as(plantAUser).post('/api/v1/expenses', {
      factoryId: X.plantB.id, expenseDate: '2026-08-21', category: 'Smuggled', mode: 'BANK', amountPaise: 500,
    });
    expect(res.status).toBe(403);
    const check = await as(owner).get('/api/v1/expenses');
    expect(check.body.data.rows.some((e) => e.category === 'Smuggled')).toBe(false);
  });

  it('refuses an explicit ?factoryId= filter for a forbidden plant (same and other organisation)', async () => {
    expect((await as(plantAUser).get(`/api/v1/expenses?factoryId=${X.plantB.id}`)).status).toBe(403);
    expect((await as(plantAUser).get(`/api/v1/expenses?factoryId=${X.plantC.id}`)).status).toBe(403);
  });

  it('ignores an organisation id injected into the create body', async () => {
    // validate() strips undeclared keys, and tenant/organisation ownership is
    // derived server-side — the injected value must change nothing.
    const res = await as(plantAUser).post('/api/v1/expenses', {
      factoryId: X.plantA.id, expenseDate: '2026-08-21', category: 'OrgTamper', mode: 'BANK',
      amountPaise: 700, organizationId: X.orgTwo.id, tenantId: '00000000-0000-0000-0000-000000000001',
    });
    expect(res.status).toBe(201);
    expect(res.body.data.factoryId).toBe(X.plantA.id);
  });
});

describe('F — the factory list behind every dropdown', () => {
  it('offers a plant-scoped user only their own plant', async () => {
    const res = await as(plantAUser).get('/api/v1/factories');
    expect(res.status).toBe(200);
    expect(res.body.data.rows.map((f) => f.id)).toEqual([X.plantA.id]);
  });

  it('404s a direct fetch of an unassigned plant', async () => {
    expect((await as(plantAUser).get(`/api/v1/factories/${X.plantB.id}`)).status).toBe(404);
    expect((await as(plantAUser).get(`/api/v1/factories/${X.plantC.id}`)).status).toBe(404);
  });

  it('still lists every plant for the unrestricted owner (I)', async () => {
    const res = await as(owner).get('/api/v1/factories');
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toHaveLength(3);
  });

  it('refuses a plant-scoped administrator modifying or deleting an unassigned plant', async () => {
    expect((await as(hrAdminA).put(`/api/v1/factories/${X.plantB.id}`, { name: 'Hijacked' })).status).toBe(404);
    expect((await as(hrAdminA).del(`/api/v1/factories/${X.plantB.id}`)).status).toBe(404);
    const fresh = await Factory.unscoped().findByPk(X.plantB.id);
    expect(fresh.name).toBe('Plant B');
  });
});

describe('H — assigning organisation and factory on the user editor', () => {
  it('lets a plant-scoped administrator create a user in their own organisation and plant', async () => {
    const res = await as(hrAdminA).post('/api/v1/users', {
      email: 'newhire@isolation.test', password: PASSWORD, sendInvite: false,
      firstName: 'New', lastName: 'Hire',
      organizationId: X.orgOne.id, factoryIds: [X.plantA.id],
    });
    expect(res.status).toBe(201);
    const rows = await UserFactory.unscoped().findAll({ where: { userId: res.body.data.id } });
    expect(rows.map((r) => r.factoryId)).toEqual([X.plantA.id]);
  });

  it('writes an audit row for the assignment', async () => {
    const entries = await AuditLog.unscoped().findAll({ where: { entityType: 'UserFactory', action: 'CREATE' } });
    expect(entries.length).toBeGreaterThan(0);
  });

  it('refuses a factory that does not belong to the selected organisation', async () => {
    const res = await as(hrAdminA).post('/api/v1/users', {
      email: 'crossorg@isolation.test', password: PASSWORD, sendInvite: false,
      firstName: 'Cross', lastName: 'Org',
      organizationId: X.orgOne.id, factoryIds: [X.plantC.id],
    });
    expect(res.status).toBe(400);
  });

  it('refuses factories without an organisation to validate them against', async () => {
    const res = await as(hrAdminA).post('/api/v1/users', {
      email: 'noorg@isolation.test', password: PASSWORD, sendInvite: false,
      firstName: 'No', lastName: 'Org', factoryIds: [X.plantA.id],
    });
    expect(res.status).toBe(400);
  });

  it('refuses a plant-scoped administrator handing out a plant beyond their own scope', async () => {
    const res = await as(hrAdminA).post('/api/v1/users', {
      email: 'widen@isolation.test', password: PASSWORD, sendInvite: false,
      firstName: 'Widen', lastName: 'Scope',
      organizationId: X.orgOne.id, factoryIds: [X.plantA.id, X.plantB.id],
    });
    expect(res.status).toBe(403);
  });

  it('refuses a plant-scoped administrator filing a user under another organisation', async () => {
    const res = await as(hrAdminA).post('/api/v1/users', {
      email: 'otherorg@isolation.test', password: PASSWORD, sendInvite: false,
      firstName: 'Other', lastName: 'Org', organizationId: X.orgTwo.id,
    });
    expect(res.status).toBe(403);
  });

  it('refuses the same administrator revoking an assignment they cannot reach, via the user editor', async () => {
    // A user assigned to Plant B, which hrAdminA cannot act on.
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const target = await User.create(
      { tenantId: X.tenantId, email: 'plantb-staff@isolation.test', passwordHash, firstName: 'Plant', lastName: 'B', role: 'EMPLOYEE', status: 'ACTIVE', organizationId: X.orgOne.id },
      { validate: false }
    );
    await UserFactory.create({ tenantId: X.tenantId, userId: target.id, factoryId: X.plantB.id });

    const res = await as(hrAdminA).put(`/api/v1/users/${target.id}`, { factoryIds: [] });
    expect(res.status).toBe(403);
    expect(await UserFactory.unscoped().count({ where: { userId: target.id } })).toBe(1);
    X.plantBStaff = target;
  });

  it('refuses the factory-screen assignment endpoints for an unassigned plant, too', async () => {
    expect((await as(hrAdminA).post(`/api/v1/factories/${X.plantB.id}/users`, { userId: X.aUser.id })).status).toBe(403);
    expect((await as(hrAdminA).del(`/api/v1/factories/${X.plantB.id}/users/${X.plantBStaff.id}`)).status).toBe(403);
    expect(await UserFactory.unscoped().count({ where: { userId: X.plantBStaff.id } })).toBe(1);
  });

  it('lets the unrestricted owner assign across organisations (I)', async () => {
    const res = await as(owner).post('/api/v1/users', {
      email: 'orgtwo-staff@isolation.test', password: PASSWORD, sendInvite: false,
      firstName: 'Org', lastName: 'Two',
      organizationId: X.orgTwo.id, factoryIds: [X.plantC.id],
    });
    expect(res.status).toBe(201);
  });

  it('refuses moving a user to an organisation their plants do not belong to', async () => {
    // aUser is assigned to Plant A (Organisation One); switching the user to
    // Organisation Two without a consistent factoryIds list must not pass.
    const res = await as(owner).put(`/api/v1/users/${X.aUser.id}`, { organizationId: X.orgTwo.id });
    expect(res.status).toBe(400);
  });
});

describe('J — reassignment ends the old plant\'s access at once', () => {
  it('moves the user from Plant A to Plant B and their old session stops working', async () => {
    const res = await as(owner).put(`/api/v1/users/${X.aUser.id}`, { factoryIds: [X.plantB.id] });
    expect(res.status).toBe(200);

    // The old access token was minted before the permissionsVersion bump.
    expect((await as(plantAUser).get('/api/v1/expenses')).status).toBe(401);

    // A fresh session sees the new plant and only the new plant.
    const fresh = await loginAs('planta@isolation.test');
    const list = await as(fresh).get('/api/v1/expenses');
    expect(list.status).toBe(200);
    expect(list.body.data.rows).toHaveLength(1);
    expect(list.body.data.rows[0].factoryId).toBe(X.plantB.id);
    expect((await as(fresh).get(`/api/v1/expenses/${X.expenseA.id}`)).status).toBe(404);

    const factories = await as(fresh).get('/api/v1/factories');
    expect(factories.body.data.rows.map((f) => f.id)).toEqual([X.plantB.id]);
  });
});
