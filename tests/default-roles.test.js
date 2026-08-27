/**
 * The default plant roles actually work.
 *
 * Not "the grant strings look plausible" — an actual user is put in each role
 * and hits the endpoints that role exists to use, plus one it should be refused.
 * Before this, no seeded role held a single operational permission, so every
 * production, quality, inventory and vehicle screen was superuser-only.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, AdGroup, AdGroupMember, UserFactory,
} = require('../src/models/index');
const { DEFAULT_ROLES } = require('../src/constants/defaultRoles');
const { isKnownPermission } = require('../src/utils/permissionCatalog');

const PASSWORD = 'password123';
let tenantId;
let factory;
const cookies = {};

const extractCookie = (res, name) => {
  const list = res.headers['set-cookie'] || [];
  const match = list.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

/** One user per role, so a 403 can only mean the role's grants are wrong. */
const makeUserInRole = async (roleName, email) => {
  const role = DEFAULT_ROLES.find((r) => r.name === roleName);
  const group = await AdGroup.create({
    tenantId, name: roleName, description: role.description, permissions: role.permissions, status: 'active',
  });
  const user = await User.create(
    { tenantId, email, passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: roleName, lastName: 'User', role: 'EMPLOYEE' },
    { validate: false }
  );
  await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });

  // A role grant is only half of access. BR-29 also requires the user to be
  // assigned to the location: enforceFactoryScope refuses any request naming a
  // factoryId the caller has no UserFactory row for, whatever their permissions
  // say. Modules that take factoryId as a mandatory parameter (GST returns, for
  // one) are therefore unreachable without this, which is exactly how a real
  // deployment has to be set up.
  await UserFactory.create({ tenantId, userId: user.id, factoryId: factory.id });

  const login = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return extractCookie(login, 'accessToken');
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Roles Co', slug: 'roles-co', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Roles Co Ltd', code: 'RC' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Roles Plant', code: 'RC-FAC', varianceThresholdPercent: 5 });

  cookies.production = await makeUserInRole('Production Supervisor', 'prod@roles.co');
  cookies.quality = await makeUserInRole('Quality Inspector', 'qc@roles.co');
  cookies.stores = await makeUserInRole('Store Keeper', 'stores@roles.co');
  cookies.sales = await makeUserInRole('Sales Executive', 'sales@roles.co');
  cookies.accounts = await makeUserInRole('Accountant', 'accounts@roles.co');
  cookies.manager = await makeUserInRole('Plant Manager', 'manager@roles.co');
});

afterAll(async () => {
  await sequelize.close();
});

describe('every default role is made of real permissions', () => {
  it('names only codes the catalog knows', () => {
    const unknown = DEFAULT_ROLES.flatMap((r) =>
      r.permissions.filter((p) => p !== '*' && !isKnownPermission(p)).map((p) => `${r.name}: ${p}`)
    );
    expect(unknown).toEqual([]);
  });

  it('covers every operational module across the set', () => {
    const all = new Set(DEFAULT_ROLES.flatMap((r) => r.permissions));
    // The gap this whole file exists to close: these were held by nobody.
    ['PRODUCTION_DELETE', 'QUALITY_CREATE', 'QUALITY_MODIFY', 'VEHICLE_CREATE',
     'INVENTORY_CREATE', 'SALES_CREATE', 'PURCHASE_CREATE', 'DISPATCH_CREATE'].forEach((code) => {
      expect([code, all.has(code)]).toEqual([code, true]);
    });
  });
});

describe('Production Supervisor', () => {
  it('can reach production and wastage', async () => {
    for (const url of ['/api/v1/production/entries', '/api/v1/production/orders', '/api/v1/production/wastage']) {
      const res = await request(app).get(url).set('Cookie', cookies.production);
      expect([url, res.status]).toEqual([url, 200]);
    }
  });

  it('can see which lots are held for testing but cannot sign a test off', async () => {
    const read = await request(app).get('/api/v1/quality').set('Cookie', cookies.production);
    expect(read.status).toBe(200);

    const write = await request(app).post('/api/v1/quality').set('Cookie', cookies.production)
      .send({ factoryId: factory.id, productId: factory.id, inspectionType: 'FINAL', inspectionDate: '2026-08-27' });
    expect(write.status).toBe(403);
  });

  it('is kept away from money', async () => {
    const res = await request(app).get('/api/v1/ledger/trial-balance').set('Cookie', cookies.production);
    expect(res.status).toBe(403);
  });
});

describe('Quality Inspector', () => {
  it('can reach the inspection screens', async () => {
    for (const url of ['/api/v1/quality', '/api/v1/quality/held-lots']) {
      const res = await request(app).get(url).set('Cookie', cookies.quality);
      expect([url, res.status]).toEqual([url, 200]);
    }
  });

  it('cannot record a casting run', async () => {
    const res = await request(app).post('/api/v1/production/entries').set('Cookie', cookies.quality)
      .send({ factoryId: factory.id, productId: factory.id, productionDate: '2026-08-27', goodQty: 1 });
    expect(res.status).toBe(403);
  });
});

describe('Store Keeper', () => {
  it('can reach stock, transfers, receipts and the fleet', async () => {
    for (const url of [
      '/api/v1/inventory/lots',
      '/api/v1/inventory/reservations',
      '/api/v1/transfers',
      '/api/v1/purchasing/receipts',
      '/api/v1/vehicles',
    ]) {
      const res = await request(app).get(url).set('Cookie', cookies.stores);
      expect([url, res.status]).toEqual([url, 200]);
    }
  });

  it('can add a vehicle', async () => {
    const res = await request(app).post('/api/v1/vehicles').set('Cookie', cookies.stores)
      .send({ registrationNumber: 'OD09ZZ1111' });
    expect(res.status).toBe(201);
  });

  it('cannot approve a purchase indent it raised', async () => {
    // PURCHASE_CREATE without PURCHASE_APPROVE — raising and approving are
    // deliberately different grants (FR-M11-1).
    const role = DEFAULT_ROLES.find((r) => r.name === 'Store Keeper');
    expect(role.permissions).toContain('PURCHASE_CREATE');
    expect(role.permissions).not.toContain('PURCHASE_APPROVE');
  });
});

describe('Sales Executive', () => {
  it('can reach orders, dispatch and customers', async () => {
    for (const url of ['/api/v1/sales/orders', '/api/v1/dispatch/challans', '/api/v1/parties']) {
      const res = await request(app).get(url).set('Cookie', cookies.sales);
      expect([url, res.status]).toEqual([url, 200]);
    }
  });

  it('cannot override a customer credit limit', () => {
    const role = DEFAULT_ROLES.find((r) => r.name === 'Sales Executive');
    expect(role.permissions).not.toContain('SALES_CREDIT_OVERRIDE');
  });

  it('cannot record a casting run', async () => {
    const res = await request(app).get('/api/v1/production/entries').set('Cookie', cookies.sales);
    expect(res.status).toBe(403);
  });
});

describe('Accountant', () => {
  it('can reach the books', async () => {
    const gstr = `/api/v1/gstr/gstr1?factoryId=${factory.id}&fromDate=2026-08-01&toDate=2026-08-31`;
    for (const url of ['/api/v1/invoices', '/api/v1/payments', '/api/v1/expenses', gstr]) {
      const res = await request(app).get(url).set('Cookie', cookies.accounts);
      expect([url, res.status]).toEqual([url, 200]);
    }
  });

  it('cannot record production', async () => {
    const res = await request(app).get('/api/v1/production/entries').set('Cookie', cookies.accounts);
    expect(res.status).toBe(403);
  });
});

describe('a role grant is not enough on its own', () => {
  it('still refuses a location the user is not assigned to (BR-29)', async () => {
    const other = await Factory.create({
      tenantId, organizationId: (await Organization.findOne({ where: { tenantId } })).id,
      name: 'Other Plant', code: 'RC-FAC-2', varianceThresholdPercent: 5,
    });

    // Same accountant, same GSTR_READ grant, different plant.
    const res = await request(app)
      .get(`/api/v1/gstr/gstr1?factoryId=${other.id}&fromDate=2026-08-01&toDate=2026-08-31`)
      .set('Cookie', cookies.accounts);
    expect(res.status).toBe(403);
  });
});

describe('Plant Manager', () => {
  it('sees across the operation', async () => {
    for (const url of [
      '/api/v1/production/orders',
      '/api/v1/quality/held-lots',
      '/api/v1/inventory/lots',
      '/api/v1/sales/orders',
      '/api/v1/vehicles',
    ]) {
      const res = await request(app).get(url).set('Cookie', cookies.manager);
      expect([url, res.status]).toEqual([url, 200]);
    }
  });

  it('cannot edit roles — that stays with an administrator', async () => {
    const res = await request(app).get('/api/v1/roles').set('Cookie', cookies.manager);
    expect(res.status).toBe(403);
  });
});
