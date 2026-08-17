const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, AdGroup, AdGroupMember } = require('../src/models/index');
const {
  ALL_PERMISSIONS,
  expandPermissions,
  normalizePermissions,
  isKnownPermission,
} = require('../src/utils/permissionCatalog');

const PASSWORD = 'password123';

let tenantId;
let organizationId;
let adminCookie;
let creatorCookie;
let modifierCookie;
let legacyCookie;
let wildcardCookie;
let roleAdminCookie;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const loginAs = async (email) => {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  return extractCookie(res, 'accessToken');
};

/** Creates an EMPLOYEE-role user whose only access comes from `permissions`. */
const createUserWithPermissions = async (email, permissions) => {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await User.create(
    { tenantId, email, passwordHash, firstName: 'Test', lastName: 'User', role: 'EMPLOYEE' },
    { validate: false }
  );
  const group = await AdGroup.create({ tenantId, name: `Group ${email}`, permissions });
  await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });
  return loginAs(email);
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'RBAC Co', slug: 'rbac-co', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'RBAC Co Pvt Ltd', code: 'RBAC' });
  organizationId = org.id;

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: 'admin@rbac.test', passwordHash, firstName: 'Ada', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  adminCookie = await loginAs('admin@rbac.test');

  creatorCookie = await createUserWithPermissions('creator@rbac.test', ['PRODUCT_READ', 'PRODUCT_CREATE']);
  modifierCookie = await createUserWithPermissions('modifier@rbac.test', ['PRODUCT_READ', 'PRODUCT_MODIFY']);
  // Deliberately stores the pre-split coarse code, the way rows written before
  // the CRUD split (and the seeds) still do.
  legacyCookie = await createUserWithPermissions('legacy@rbac.test', ['PRODUCT_WRITE']);
  wildcardCookie = await createUserWithPermissions('wildcard@rbac.test', ['*']);
  roleAdminCookie = await createUserWithPermissions('roleadmin@rbac.test', [
    'ROLE_READ',
    'ROLE_CREATE',
    'ROLE_MODIFY',
    'PRODUCT_READ',
  ]);
});

afterAll(async () => {
  await sequelize.close();
});

describe('permission catalog', () => {
  it('exposes every code referenced by a route guard', () => {
    // Guards and catalog drifting apart is the failure mode that silently locks
    // people out, so assert the relationship rather than trusting review.
    const fs = require('fs');
    const path = require('path');
    const walk = (dir) =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

    const referenced = new Set();
    for (const file of walk(path.join(__dirname, '..', 'src'))) {
      if (!file.endsWith('.js')) continue;
      for (const call of fs.readFileSync(file, 'utf8').matchAll(/authorize\(([^)]*)\)/g)) {
        for (const code of call[1].matchAll(/'([A-Z_]+)'/g)) referenced.add(code[1]);
      }
    }

    expect(referenced.size).toBeGreaterThan(50);
    expect([...referenced].filter((code) => !isKnownPermission(code))).toEqual([]);
  });

  it('serves the module tree to a role reader', async () => {
    const res = await request(app).get('/api/v1/roles/permission-catalog').set('Cookie', roleAdminCookie);

    expect(res.status).toBe(200);
    const { modules, grantable } = res.body.data;
    expect(modules.length).toBeGreaterThan(0);

    const resource = modules.flatMap((m) => m.resources).find((r) => r.key === 'PRODUCT');
    expect(resource.actions).toEqual(['READ', 'CREATE', 'MODIFY', 'DELETE']);

    // grantable is scoped to what this user holds, not the whole catalog.
    expect(grantable).toContain('PRODUCT_READ');
    expect(grantable).not.toContain('PRODUCT_DELETE');
  });

  it('refuses the catalog to a user without ROLE_READ', async () => {
    const res = await request(app).get('/api/v1/roles/permission-catalog').set('Cookie', creatorCookie);
    expect(res.status).toBe(403);
  });

  it('gives a bypass role the entire catalog as grantable', async () => {
    const res = await request(app).get('/api/v1/roles/permission-catalog').set('Cookie', adminCookie);
    expect(res.body.data.grantable).toHaveLength(ALL_PERMISSIONS.length);
  });
});

describe('per-action enforcement', () => {
  it('lets CREATE post but not modify or delete', async () => {
    const created = await request(app)
      .post('/api/v1/uoms')
      .set('Cookie', creatorCookie)
      .send({ code: 'BAG', name: 'Bag' });
    expect(created.status).toBe(201);

    const uomId = created.body.data.id;

    const modified = await request(app)
      .put(`/api/v1/uoms/${uomId}`)
      .set('Cookie', creatorCookie)
      .send({ name: 'Bags' });
    expect(modified.status).toBe(403);

    const deleted = await request(app).delete(`/api/v1/uoms/${uomId}`).set('Cookie', creatorCookie);
    expect(deleted.status).toBe(403);
  });

  it('lets MODIFY put but not create', async () => {
    const created = await request(app)
      .post('/api/v1/uoms')
      .set('Cookie', creatorCookie)
      .send({ code: 'TON', name: 'Tonne' });
    const uomId = created.body.data.id;

    const modified = await request(app)
      .put(`/api/v1/uoms/${uomId}`)
      .set('Cookie', modifierCookie)
      .send({ name: 'Metric Tonne' });
    expect(modified.status).toBe(200);

    const blocked = await request(app)
      .post('/api/v1/uoms')
      .set('Cookie', modifierCookie)
      .send({ code: 'KG', name: 'Kilogram' });
    expect(blocked.status).toBe(403);
  });
});

describe('backwards compatibility with pre-split roles', () => {
  it('still grants all three write actions for a stored _WRITE code', async () => {
    const created = await request(app)
      .post('/api/v1/uoms')
      .set('Cookie', legacyCookie)
      .send({ code: 'BOX', name: 'Box' });
    expect(created.status).toBe(201);

    const uomId = created.body.data.id;

    const modified = await request(app)
      .put(`/api/v1/uoms/${uomId}`)
      .set('Cookie', legacyCookie)
      .send({ name: 'Carton' });
    expect(modified.status).toBe(200);

    const deleted = await request(app).delete(`/api/v1/uoms/${uomId}`).set('Cookie', legacyCookie);
    expect(deleted.status).toBe(200);
  });

  it('honours the seeded wildcard on a granular guard', async () => {
    const res = await request(app)
      .post('/api/v1/uoms')
      .set('Cookie', wildcardCookie)
      .send({ code: 'PCS', name: 'Pieces' });
    expect(res.status).toBe(201);
  });

  it('keeps the wildcard compact in the token instead of inlining the catalog', async () => {
    // Expanding '*' to ~110 codes would push the auth cookie towards the 4KB
    // per-cookie browser limit, so it has to stay a wildcard on the wire.
    expect(expandPermissions(['*'])).toEqual(['*']);

    const res = await request(app).post('/api/v1/auth/login').send({
      email: 'wildcard@rbac.test',
      password: PASSWORD,
    });
    const cookie = (res.headers['set-cookie'] || []).find((c) => c.startsWith('accessToken='));
    expect(cookie.length).toBeLessThan(4096);
  });

  it('expands _WRITE to the write actions plus read, and leaves unknown codes alone', () => {
    expect(expandPermissions(['PRODUCT_WRITE']).sort()).toEqual(
      ['PRODUCT_CREATE', 'PRODUCT_DELETE', 'PRODUCT_MODIFY', 'PRODUCT_READ'].sort()
    );
    // LEDGER is read-only, so there is no alias to widen.
    expect(expandPermissions(['LEDGER_WRITE'])).toEqual(['LEDGER_WRITE']);
  });
});

describe('role writes', () => {
  it('rejects an unknown permission code with a message naming it', async () => {
    const res = await request(app)
      .post('/api/v1/roles')
      .set('Cookie', adminCookie)
      .send({ name: 'Typo Role', permissions: ['PRODUCT_READ', 'PRODCUT_CREATE'] });

    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('PRODCUT_CREATE');
  });

  it('stores permissions de-duplicated and in catalog order', async () => {
    const res = await request(app)
      .post('/api/v1/roles')
      .set('Cookie', adminCookie)
      .send({
        name: 'Tidy Role',
        permissions: ['PRODUCT_DELETE', 'EMPLOYEE_READ', 'PRODUCT_DELETE', 'PRODUCT_READ'],
      });

    expect(res.status).toBe(201);
    expect(res.body.data.permissions).toEqual(['EMPLOYEE_READ', 'PRODUCT_READ', 'PRODUCT_DELETE']);
  });

  it('blocks granting a permission the author does not hold', async () => {
    const res = await request(app)
      .post('/api/v1/roles')
      .set('Cookie', roleAdminCookie)
      .send({ name: 'Escalation', permissions: ['PRODUCT_READ', 'PRODUCT_DELETE'] });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('PRODUCT_DELETE');
  });

  it('blocks laundering an escalation through the legacy _WRITE alias', async () => {
    const res = await request(app)
      .post('/api/v1/roles')
      .set('Cookie', roleAdminCookie)
      .send({ name: 'Laundered', permissions: ['PRODUCT_WRITE'] });

    expect(res.status).toBe(403);
  });

  it('allows granting a permission the author does hold', async () => {
    const res = await request(app)
      .post('/api/v1/roles')
      .set('Cookie', roleAdminCookie)
      .send({ name: 'Product Viewer', permissions: ['PRODUCT_READ'] });

    expect(res.status).toBe(201);
    expect(res.body.data.permissions).toEqual(['PRODUCT_READ']);
  });

  it('lets a limited author re-save a role that already out-ranks them', async () => {
    const role = await AdGroup.create({
      tenantId,
      name: 'Out-ranks Me',
      permissions: ['PRODUCT_READ', 'PRODUCT_DELETE'],
    });

    // roleadmin holds no PRODUCT_DELETE, but isn't adding it either — the editor
    // just posts back the list it was given, with the name changed.
    const res = await request(app)
      .put(`/api/v1/roles/${role.id}`)
      .set('Cookie', roleAdminCookie)
      .send({ name: 'Renamed', permissions: ['PRODUCT_READ', 'PRODUCT_DELETE'] });

    expect(res.status).toBe(200);
    expect(res.body.data.name).toBe('Renamed');
  });

  it('still blocks adding a new out-of-reach permission to that role', async () => {
    const role = await AdGroup.create({
      tenantId,
      name: 'Creeping Scope',
      permissions: ['PRODUCT_READ', 'PRODUCT_DELETE'],
    });

    const res = await request(app)
      .put(`/api/v1/roles/${role.id}`)
      .set('Cookie', roleAdminCookie)
      .send({ permissions: ['PRODUCT_READ', 'PRODUCT_DELETE', 'EMPLOYEE_DELETE'] });

    expect(res.status).toBe(403);
    expect(res.body.message).toContain('EMPLOYEE_DELETE');
    expect(res.body.message).not.toContain('PRODUCT_DELETE');
  });

  it('lets a limited author remove a permission they could not grant', async () => {
    const role = await AdGroup.create({
      tenantId,
      name: 'Shrinking',
      permissions: ['PRODUCT_READ', 'PRODUCT_DELETE'],
    });

    const res = await request(app)
      .put(`/api/v1/roles/${role.id}`)
      .set('Cookie', roleAdminCookie)
      .send({ permissions: ['PRODUCT_READ'] });

    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toEqual(['PRODUCT_READ']);
  });

  it('leaves permissions untouched on an update that does not mention them', async () => {
    const created = await request(app)
      .post('/api/v1/roles')
      .set('Cookie', adminCookie)
      .send({ name: 'Renamable', permissions: ['PRODUCT_READ', 'PRODUCT_CREATE'] });

    const res = await request(app)
      .put(`/api/v1/roles/${created.body.data.id}`)
      .set('Cookie', adminCookie)
      .send({ description: 'Renamed only' });

    expect(res.status).toBe(200);
    expect(res.body.data.permissions).toEqual(['PRODUCT_READ', 'PRODUCT_CREATE']);
  });

  it('applies a new grant to existing members on their next login', async () => {
    const role = await AdGroup.create({ tenantId, name: 'Grows Later', permissions: ['PRODUCT_READ'] });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await User.create(
      { tenantId, email: 'grows@rbac.test', passwordHash, firstName: 'Grow', lastName: 'User', role: 'EMPLOYEE' },
      { validate: false }
    );
    await AdGroupMember.create({ tenantId, adGroupId: role.id, employeeId: user.id });

    const before = await request(app)
      .post('/api/v1/uoms')
      .set('Cookie', await loginAs('grows@rbac.test'))
      .send({ code: 'DRM', name: 'Drum' });
    expect(before.status).toBe(403);

    await request(app)
      .put(`/api/v1/roles/${role.id}`)
      .set('Cookie', adminCookie)
      .send({ permissions: ['PRODUCT_READ', 'PRODUCT_CREATE'] });

    const after = await request(app)
      .post('/api/v1/uoms')
      .set('Cookie', await loginAs('grows@rbac.test'))
      .send({ code: 'DRM', name: 'Drum' });
    expect(after.status).toBe(201);
  });

  it('ignores permissions on an inactive role', async () => {
    const role = await AdGroup.create({ tenantId, name: 'Suspended', permissions: ['PRODUCT_READ', 'PRODUCT_CREATE'] });
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const user = await User.create(
      { tenantId, email: 'suspended@rbac.test', passwordHash, firstName: 'Sus', lastName: 'User', role: 'EMPLOYEE' },
      { validate: false }
    );
    await AdGroupMember.create({ tenantId, adGroupId: role.id, employeeId: user.id });

    await request(app).put(`/api/v1/roles/${role.id}`).set('Cookie', adminCookie).send({ status: 'inactive' });

    const res = await request(app)
      .post('/api/v1/uoms')
      .set('Cookie', await loginAs('suspended@rbac.test'))
      .send({ code: 'CAN', name: 'Can' });
    expect(res.status).toBe(403);
  });
});

describe('normalizePermissions', () => {
  it('drops unknown codes and collapses the wildcard', () => {
    expect(normalizePermissions(['PRODUCT_READ', 'nope'])).toEqual(['PRODUCT_READ']);
    expect(normalizePermissions(['*', 'PRODUCT_READ'])).toEqual(['*']);
  });
});
