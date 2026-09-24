const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const fs = require('fs');
const path = require('path');
const { Tenant, User, Organization, AdGroup, AdGroupMember } = require('../src/models/index');
const { EmployeeDocument } = require('../src/api/users/employeeDocument.model');
const { Notification } = require('../src/api/notifications/notification.model');
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
let employeeAdminCookie;

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
  const { cookie } = await createUserReturning(email, permissions);
  return cookie;
};

/** Same, but hands back the row too — the escalation tests need the user's id. */
const createUserReturning = async (email, permissions) => {
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = await User.create(
    { tenantId, email, passwordHash, firstName: 'Test', lastName: 'User', role: 'EMPLOYEE' },
    { validate: false }
  );
  const group = await AdGroup.create({ tenantId, name: `Group ${email}`, permissions });
  await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });
  return { user, group, cookie: await loginAs(email) };
};

/** The permission array the API reports for whoever holds this cookie. */
const permissionsOf = async (cookie) => {
  const res = await request(app).get('/api/v1/auth/me').set('Cookie', cookie);
  return res.body.data?.permissions || [];
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
  // The grants an HR administrator actually holds, in the post-split codes the
  // catalog issues. Nothing here is legacy.
  employeeAdminCookie = await createUserWithPermissions('employeeadmin@rbac.test', [
    'EMPLOYEE_READ',
    'EMPLOYEE_CREATE',
    'EMPLOYEE_MODIFY',
    'EMPLOYEE_DELETE',
    'ORG_READ',
  ]);
});

/** Upload directories the document tests create, removed on the way out. */
const createdUploadDirs = [];

afterAll(async () => {
  for (const dir of createdUploadDirs) fs.rmSync(dir, { recursive: true, force: true });
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

  it('never guards a route with a code no role can actually hold', () => {
    // `isKnownPermission` above accepts the legacy `<RESOURCE>_WRITE` aliases,
    // because a role row is still allowed to *store* one. But expandPermissions
    // consumes an alias and emits the granular codes in its place — it never
    // re-emits the alias itself — while holdsPermission compares exactly. So a
    // guard written as authorize('EMPLOYEE_WRITE') can never pass for anyone
    // except the two bypass roles, no matter what is granted.
    //
    // That is how user management silently became superuser-only: the guard was
    // "known", so the assertion above stayed green while HR_ADMIN, ORG_ADMIN and
    // every AdGroup lost the ability to create, edit or delete a user. Assert
    // reachability, not just spelling.
    const fs = require('fs');
    const path = require('path');
    const walk = (dir) =>
      fs
        .readdirSync(dir, { withFileTypes: true })
        .flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));

    const referenced = new Set();
    for (const file of walk(path.join(__dirname, '..', 'src'))) {
      if (!file.endsWith('.js')) continue;
      const source = fs.readFileSync(file, 'utf8');
      // Both spellings a guard is written in: a literal, and WebPermissions.X.
      for (const call of source.matchAll(/(?:authorize|allowSelfOr)\(([^)]*)\)/g)) {
        for (const code of call[1].matchAll(/'([A-Z_]+)'/g)) referenced.add(code[1]);
        for (const code of call[1].matchAll(/WebPermissions\.([A-Z_]+)/g)) referenced.add(code[1]);
      }
    }

    const grantable = new Set(ALL_PERMISSIONS);
    const unreachable = [...referenced].filter((code) => code !== '*' && !grantable.has(code));
    expect(unreachable).toEqual([]);
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

describe('user administration', () => {
  // The catalog splits EMPLOYEE into READ/CREATE/MODIFY/DELETE and the seeded
  // "HR Manager" role is built from those codes, so holding them has to be
  // enough to administer a user. It was not: every write route on
  // /api/v1/users asked for the legacy EMPLOYEE_WRITE, which no expansion ever
  // produces, so the whole module answered 403 to everyone but PLATFORM_ADMIN
  // and TENANT_OWNER.
  it('lets EMPLOYEE_CREATE create a user', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set('Cookie', employeeAdminCookie)
      .send({
        email: 'hired@rbac.test',
        password: 'password123',
        firstName: 'New',
        lastName: 'Hire',
        organizationId,
        role: 'EMPLOYEE',
      });

    expect(res.status).toBe(201);
  });

  it('lets EMPLOYEE_MODIFY edit a user and EMPLOYEE_DELETE remove one', async () => {
    const passwordHash = await bcrypt.hash(PASSWORD, 10);
    const target = await User.create(
      { tenantId, email: 'target@rbac.test', passwordHash, firstName: 'Tar', lastName: 'Get', role: 'EMPLOYEE' },
      { validate: false }
    );

    const updated = await request(app)
      .put(`/api/v1/users/${target.id}`)
      .set('Cookie', employeeAdminCookie)
      .send({ firstName: 'Edited' });
    expect(updated.status).toBe(200);

    const removed = await request(app)
      .delete(`/api/v1/users/${target.id}`)
      .set('Cookie', employeeAdminCookie);
    expect(removed.status).toBe(200);
  });

  it('still refuses a user who holds only EMPLOYEE_READ', async () => {
    const readerCookie = await createUserWithPermissions('reader@rbac.test', ['EMPLOYEE_READ']);

    const res = await request(app)
      .post('/api/v1/users')
      .set('Cookie', readerCookie)
      .send({
        email: 'nope@rbac.test',
        password: 'password123',
        firstName: 'No',
        lastName: 'Pe',
        organizationId,
        role: 'EMPLOYEE',
      });

    expect(res.status).toBe(403);
  });
});

describe('privilege escalation', () => {
  // assertGrantable stops a limited author *minting* a role stronger than
  // themselves. Both holes below reach the same end by a different door:
  // neither goes near role authoring.

  it('refuses to assign a role carrying permissions the actor does not hold', async () => {
    // The seeded tenant ships a "Platform Admin" role holding '*', and
    // GET /roles hands out its id to any ROLE_READ holder.
    const superRole = await AdGroup.create({ tenantId, name: 'Superusers', permissions: ['*'] });
    const { user, cookie } = await createUserReturning('climber@rbac.test', [
      'ROLE_READ',
      'ROLE_CREATE',
      'PRODUCT_READ',
    ]);

    expect(await permissionsOf(cookie)).not.toContain('*');

    const res = await request(app)
      .post(`/api/v1/roles/${superRole.id}/members`)
      .set('Cookie', cookie)
      .send({ employeeId: user.id });

    expect(res.status).toBe(403);

    // And the grant must not have landed even if the status were wrong.
    expect(await permissionsOf(await loginAs('climber@rbac.test'))).not.toContain('*');
  });

  it('refuses to hand a user a system role through PUT /users/:id', async () => {
    // EMPLOYEE_MODIFY is an HR grant. It must not be a route to becoming
    // PLATFORM_ADMIN, which bypasses every permission check in the app.
    const { user, cookie } = await createUserReturning('hrclimber@rbac.test', [
      'EMPLOYEE_READ',
      'EMPLOYEE_MODIFY',
    ]);

    const res = await request(app)
      .put(`/api/v1/users/${user.id}`)
      .set('Cookie', cookie)
      .send({ role: 'PLATFORM_ADMIN' });

    expect(res.status).toBe(403);

    await user.reload();
    expect(user.role).toBe('EMPLOYEE');
  });

  it('refuses to attach a user to an over-powered role through PUT /users/:id', async () => {
    // roleId is the same escalation wearing the user-editor's clothes.
    const superRole = await AdGroup.create({ tenantId, name: 'Superusers 2', permissions: ['*'] });
    const { user, cookie } = await createUserReturning('hrclimber2@rbac.test', [
      'EMPLOYEE_READ',
      'EMPLOYEE_MODIFY',
    ]);

    const res = await request(app)
      .put(`/api/v1/users/${user.id}`)
      .set('Cookie', cookie)
      .send({ roleId: superRole.id });

    expect(res.status).toBe(403);
    expect(await permissionsOf(await loginAs('hrclimber2@rbac.test'))).not.toContain('*');
  });

  it('still lets an unrestricted admin assign any role', async () => {
    // The guard must not break legitimate administration.
    const superRole = await AdGroup.create({ tenantId, name: 'Superusers 3', permissions: ['*'] });
    const { user } = await createUserReturning('ordinary@rbac.test', ['PRODUCT_READ']);

    const res = await request(app)
      .post(`/api/v1/roles/${superRole.id}/members`)
      .set('Cookie', adminCookie)
      .send({ employeeId: user.id });

    expect(res.status).toBe(201);
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

describe('employee document access', () => {
  // The files used to sit under an unauthenticated express.static mount, so the
  // gate on the document *list* decided only who learned the URL.
  const DOC_DIR = path.join(__dirname, '..', 'uploads', 'employees');

  it('does not serve employee documents from the public /uploads tree', async () => {
    const res = await request(app).get('/uploads/employees/any-id/any-file.pdf');
    // Whatever the shape of the refusal, it must not be a served file.
    expect(res.status).not.toBe(200);
  });

  it('keeps the brand assets public, since the login page needs them', async () => {
    // Nothing is asserted about the body — only that this path is still routed
    // to the static handler rather than swept up by the change above.
    const res = await request(app).get('/uploads/assets/does-not-exist.png');
    expect(res.status).toBe(404);
  });

  it('refuses the document stream without a session', async () => {
    const res = await request(app).get(`/api/v1/users/${tenantId}/documents/${tenantId}/file`);
    expect(res.status).toBe(401);
  });

  it('refuses another employee\'s document to a user without EMPLOYEE_READ', async () => {
    const { user: owner } = await createUserReturning('docowner@rbac.test', []);
    const dir = path.join(DOC_DIR, owner.id);
    fs.mkdirSync(dir, { recursive: true });
    createdUploadDirs.push(dir);
    fs.writeFileSync(path.join(dir, 'secret.pdf'), 'offer letter');

    const doc = await EmployeeDocument.create({
      tenantId,
      employeeId: owner.id,
      documentType: 'Offer',
      fileName: 'secret.pdf',
      fileKey: 'secret.pdf',
      mimeType: 'application/pdf',
    });

    const outsiderCookie = await createUserWithPermissions('outsider@rbac.test', ['PRODUCT_READ']);
    const res = await request(app)
      .get(`/api/v1/users/${owner.id}/documents/${doc.id}/file`)
      .set('Cookie', outsiderCookie);

    expect(res.status).toBe(403);

    // And the holder of the grant does get it, so the gate is not simply shut.
    const allowed = await request(app)
      .get(`/api/v1/users/${owner.id}/documents/${doc.id}/file`)
      .set('Cookie', adminCookie);
    expect(allowed.status).toBe(200);
    expect(allowed.headers['content-disposition']).toContain('attachment');
  });
});

describe('notification audience', () => {
  // userId null means broadcast, set means personal (notification.model.js).
  // None of this was enforced: list ignored both the user and the factory, and
  // markAllRead cleared the entire tenant's unread queue for everybody.
  let mineId;
  let theirsId;
  let broadcastId;
  let readerCookie;

  beforeAll(async () => {
    // INVENTORY_READ so the broadcast below is one this reader may actually
    // see — a broadcast is gated on the permission for the data it summarises,
    // and an alert you cannot see is also one you cannot clear.
    const { user, cookie } = await createUserReturning('notifme@rbac.test', ['PRODUCT_READ', 'INVENTORY_READ']);
    const { user: other } = await createUserReturning('notifother@rbac.test', ['PRODUCT_READ']);
    readerCookie = cookie;

    const mine = await Notification.create({
      tenantId, type: 'CREDIT_LIMIT_BREACH', severity: 'HIGH',
      title: 'Mine', message: 'personal', userId: user.id, dedupeKey: 'k-mine',
    });
    const theirs = await Notification.create({
      tenantId, type: 'CREDIT_LIMIT_BREACH', severity: 'HIGH',
      title: 'Theirs', message: 'someone else', userId: other.id, dedupeKey: 'k-theirs',
    });
    const broadcast = await Notification.create({
      tenantId, type: 'DEAD_STOCK', severity: 'MEDIUM',
      title: 'Everyone', message: 'broadcast', userId: null, dedupeKey: 'k-all',
    });
    mineId = mine.id; theirsId = theirs.id; broadcastId = broadcast.id;
  });

  it('lists my own and broadcast alerts, never another user\'s', async () => {
    const res = await request(app).get('/api/v1/notifications?page=1&limit=50').set('Cookie', readerCookie);
    expect(res.status).toBe(200);
    const titles = res.body.data.rows.map((n) => n.title);
    expect(titles).toContain('Mine');
    expect(titles).toContain('Everyone');
    expect(titles).not.toContain('Theirs');
  });

  it('refuses to mark another user\'s notification read', async () => {
    const res = await request(app).put(`/api/v1/notifications/${theirsId}/read`).set('Cookie', readerCookie);
    expect(res.status).toBe(404);

    const theirs = await Notification.findByPk(theirsId);
    expect(theirs.readAt).toBeNull();
  });

  it('still marks my own read', async () => {
    const res = await request(app).put(`/api/v1/notifications/${mineId}/read`).set('Cookie', readerCookie);
    expect(res.status).toBe(200);
  });

  it('read-all does not clear the rest of the tenant\'s queue', async () => {
    const res = await request(app).put('/api/v1/notifications/read-all').set('Cookie', readerCookie);
    expect(res.status).toBe(200);

    // The broadcast is mine to clear; the other user's alert is not.
    const theirs = await Notification.findByPk(theirsId);
    expect(theirs.readAt).toBeNull();
    const broadcast = await Notification.findByPk(broadcastId);
    expect(broadcast.readAt).not.toBeNull();
  });
});

describe('VIEW_RATES masking', () => {
  const { maskRateFields } = require('../src/utils/fieldMasking');
  const withoutRates = { user: { role: 'EMPLOYEE', permissions: ['SALES_READ'] } };
  const withRates = { user: { role: 'EMPLOYEE', permissions: ['SALES_READ', 'VIEW_RATES'] } };

  it('masks money on nested lines, not just the header', () => {
    // The old implementation cloned the record and nulled top-level keys only,
    // so a shop-floor user read the per-unit price straight off any order or
    // invoice detail while the header total showed as masked.
    const order = {
      id: 'o1',
      totalAmountPaise: 500000,
      lines: [{ id: 'l1', quantity: 10, ratePaise: 50000, lineTotalPaise: 500000 }],
    };

    const masked = maskRateFields(order, withoutRates);
    expect(masked.totalAmountPaise).toBeNull();
    expect(masked.lines[0].ratePaise).toBeNull();
    expect(masked.lines[0].lineTotalPaise).toBeNull();
    // Non-money fields survive — masking must not empty the document.
    expect(masked.lines[0].quantity).toBe(10);
    expect(masked.id).toBe('o1');
  });

  it('masks the invoice tax block the old four-name default missed', () => {
    const invoice = {
      subtotalPaise: 100, cgstPaise: 9, sgstPaise: 9, igstPaise: 0,
      roundOffPaise: 1, totalPaise: 119,
    };
    const masked = maskRateFields(invoice, withoutRates);
    for (const key of Object.keys(invoice)) expect(masked[key]).toBeNull();
  });

  it('leaves everything alone for a user who holds VIEW_RATES', () => {
    const order = { totalAmountPaise: 500000, lines: [{ ratePaise: 50000 }] };
    expect(maskRateFields(order, withRates)).toBe(order);
  });

  it('handles a findAndCountAll payload and preserves the count', () => {
    const payload = { count: 1, rows: [{ ratePaise: 1, lines: [{ amountPaise: 2 }] }] };
    const masked = maskRateFields(payload, withoutRates);
    expect(masked.count).toBe(1);
    expect(masked.rows[0].ratePaise).toBeNull();
    expect(masked.rows[0].lines[0].amountPaise).toBeNull();
  });

  it('does not walk into dates or choke on nulls', () => {
    const when = new Date('2026-01-01T00:00:00Z');
    const masked = maskRateFields({ createdAt: when, note: null, ratePaise: 5 }, withoutRates);
    expect(masked.createdAt).toEqual(when);
    expect(masked.note).toBeNull();
    expect(masked.ratePaise).toBeNull();
  });
});

describe('RBAC audit trail', () => {
  const { AuditLog } = require('../src/api/audit/auditLog.model');

  const auditRowsFor = async (entityType, entityId) =>
    AuditLog.findAll({ where: { entityType, entityId } });

  it('records who put a user into a role', async () => {
    // AdGroupMember was a plain scoped model, so the single most
    // access-relevant write in the product left no trace at all, while the role
    // definition next door was fully audited.
    const role = await AdGroup.create({ tenantId, name: 'Audited Role', permissions: ['PRODUCT_READ'] });
    const { user } = await createUserReturning('auditme@rbac.test', ['PRODUCT_READ']);

    const res = await request(app)
      .post(`/api/v1/roles/${role.id}/members`)
      .set('Cookie', adminCookie)
      .send({ employeeId: user.id });
    expect(res.status).toBe(201);

    const rows = await auditRowsFor('AdGroupMember', res.body.data.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe('CREATE');
    expect(rows[0].userId).toBeTruthy();
    expect(rows[0].afterSnapshot.employeeId).toBe(user.id);
  });

  it('records a delete, which previously vanished silently', async () => {
    const role = await AdGroup.create({ tenantId, name: 'Doomed Role', permissions: [] });

    const res = await request(app).delete(`/api/v1/roles/${role.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);

    const rows = await auditRowsFor('AdGroup', role.id);
    const deletes = rows.filter((r) => r.action === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(deletes[0].beforeSnapshot.name).toBe('Doomed Role');
  });

  it('records a change to a user\'s system role', async () => {
    const { user } = await createUserReturning('rolechange@rbac.test', []);

    const res = await request(app)
      .put(`/api/v1/users/${user.id}`)
      .set('Cookie', adminCookie)
      .send({ role: 'MANAGER' });
    expect(res.status).toBe(200);

    const rows = await auditRowsFor('User', user.id);
    const update = rows.find((r) => r.action === 'UPDATE' && r.afterSnapshot?.role);
    expect(update).toBeTruthy();
    expect(update.beforeSnapshot.role).toBe('EMPLOYEE');
    expect(update.afterSnapshot.role).toBe('MANAGER');
  });

  it('never writes a credential into an audit row', async () => {
    const res = await request(app)
      .post('/api/v1/users')
      .set('Cookie', adminCookie)
      .send({
        email: 'audited-hire@rbac.test',
        password: 'password123',
        firstName: 'Aud',
        lastName: 'Ited',
        organizationId,
        role: 'EMPLOYEE',
      });
    expect(res.status).toBe(201);

    const rows = await auditRowsFor('User', res.body.data.id);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      const blob = JSON.stringify([row.beforeSnapshot, row.afterSnapshot]);
      expect(blob).not.toContain('passwordHash');
      expect(blob).not.toContain('resetPasswordToken');
    }
  });
});

describe('self-approval', () => {
  const { Factory } = require('../src/api/factory/factory.model');
  const { UserFactory } = require('../src/api/factory/userFactory.model');
  let factoryId;

  beforeAll(async () => {
    const factory = await Factory.create({
      tenantId, organizationId, name: 'Approval Plant', code: 'APV-FAC', state: 'Odisha',
    });
    factoryId = factory.id;
  });

  /** BR-29 is enforced before the approval rule, so the actor needs the plant. */
  const atThisFactory = async (email, permissions) => {
    const { user, cookie } = await createUserReturning(email, permissions);
    await UserFactory.create({ tenantId, userId: user.id, factoryId });
    return { user, cookie: await loginAs(email) };
  };

  // "Approval is separate from doing" was stated in defaultRoles.js and enforced
  // in exactly one place (leave). Indents and production variance could not
  // enforce it at all: neither record stored who raised it.
  const { PurchaseIndent } = require('../src/api/purchasing/purchaseIndent.model');

  it('refuses to approve a purchase indent you raised yourself', async () => {
    const { user, cookie } = await atThisFactory('buyer@rbac.test', [
      'PURCHASE_READ',
      'PURCHASE_CREATE',
      'PURCHASE_APPROVE',
      'FACTORY_READ',
    ]);

    const indent = await PurchaseIndent.create({
      tenantId,
      factoryId,
      indentNumber: 'IND-SELF-1',
      indentDate: new Date(),
      status: 'PENDING_APPROVAL',
      requestedBy: user.id,
    });

    const res = await request(app)
      .put(`/api/v1/purchasing/indents/${indent.id}/approve`)
      .set('Cookie', cookie)
      .send({});

    expect(res.status).toBe(403);
    await indent.reload();
    expect(indent.status).toBe('PENDING_APPROVAL');
  });

  it('lets a different holder of the grant approve it', async () => {
    const { user } = await atThisFactory('buyer2@rbac.test', ['PURCHASE_CREATE']);
    const { cookie: approverCookie } = await atThisFactory('approver@rbac.test', [
      'PURCHASE_READ',
      'PURCHASE_APPROVE',
      'FACTORY_READ',
    ]);

    const indent = await PurchaseIndent.create({
      tenantId,
      factoryId,
      indentNumber: 'IND-SELF-2',
      indentDate: new Date(),
      status: 'PENDING_APPROVAL',
      requestedBy: user.id,
    });

    const res = await request(app)
      .put(`/api/v1/purchasing/indents/${indent.id}/approve`)
      .set('Cookie', approverCookie)
      .send({});

    expect(res.status).toBe(200);
  });

  it('does not block an old indent whose author was never recorded', async () => {
    // Rows written before the column existed have a null author. Unknown means
    // "cannot prove self-approval", not "assume the worst".
    const { cookie } = await atThisFactory('approver2@rbac.test', [
      'PURCHASE_READ',
      'PURCHASE_APPROVE',
      'FACTORY_READ',
    ]);

    const indent = await PurchaseIndent.create({
      tenantId,
      factoryId,
      indentNumber: 'IND-LEGACY-1',
      indentDate: new Date(),
      status: 'PENDING_APPROVAL',
      requestedBy: null,
    });

    const res = await request(app)
      .put(`/api/v1/purchasing/indents/${indent.id}/approve`)
      .set('Cookie', cookie)
      .send({});

    expect(res.status).toBe(200);
  });
});

describe('permission freshness', () => {
  // Permissions ride in the access token and `authenticate` used to verify only
  // its signature, so a revocation took effect whenever the token happened to
  // expire — up to JWT_ACCESS_EXPIRATION, which defaults to an hour. There was
  // no way to shorten that for one user: revokeRefreshTokens only touches the
  // refresh table.
  it('stops honouring a token once the role behind it loses the permission', async () => {
    const { group, cookie } = await createUserReturning('fresh@rbac.test', ['PRODUCT_READ', 'UOM_READ']);

    const before = await request(app).get('/api/v1/products?page=1&limit=5').set('Cookie', cookie);
    expect(before.status).toBe(200);

    // Same cookie, permission taken away underneath it.
    await request(app)
      .put(`/api/v1/roles/${group.id}`)
      .set('Cookie', adminCookie)
      .send({ permissions: [] });

    const after = await request(app).get('/api/v1/products?page=1&limit=5').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });

  it('stops honouring a token when the holder is removed from the role', async () => {
    const { user, group, cookie } = await createUserReturning('fresh2@rbac.test', ['PRODUCT_READ']);
    expect((await request(app).get('/api/v1/products?page=1&limit=5').set('Cookie', cookie)).status).toBe(200);

    await request(app)
      .delete(`/api/v1/roles/${group.id}/members/${user.id}`)
      .set('Cookie', adminCookie);

    const after = await request(app).get('/api/v1/products?page=1&limit=5').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });

  it('cuts off a disabled account at once, not at token expiry', async () => {
    const { user, cookie } = await createUserReturning('disabled@rbac.test', ['PRODUCT_READ']);
    expect((await request(app).get('/api/v1/products?page=1&limit=5').set('Cookie', cookie)).status).toBe(200);

    await user.update({ status: 'TERMINATED' });

    const after = await request(app).get('/api/v1/products?page=1&limit=5').set('Cookie', cookie);
    expect(after.status).toBe(401);
  });

  it('leaves an untouched user\'s session alone', async () => {
    // Revocation is per user: editing one role must not sign out the tenant.
    const { cookie: bystander } = await createUserReturning('bystander@rbac.test', ['PRODUCT_READ']);
    const { group } = await createUserReturning('victim@rbac.test', ['PRODUCT_READ']);

    await request(app)
      .put(`/api/v1/roles/${group.id}`)
      .set('Cookie', adminCookie)
      .send({ permissions: [] });

    const after = await request(app).get('/api/v1/products?page=1&limit=5').set('Cookie', bystander);
    expect(after.status).toBe(200);
  });

  it('lets the holder refresh into a token that reflects the new grant', async () => {
    // The exempt paths matter: a stale token must still be able to refresh, or
    // the user is stuck in the state we are rejecting.
    const { group } = await createUserReturning('refresher@rbac.test', ['PRODUCT_READ']);
    const login = await request(app)
      .post('/api/v1/auth/login')
      .send({ email: 'refresher@rbac.test', password: PASSWORD });
    const refreshCookie = extractCookie(login, 'refreshToken');

    await request(app)
      .put(`/api/v1/roles/${group.id}`)
      .set('Cookie', adminCookie)
      .send({ permissions: [] });

    const refreshed = await request(app).post('/api/v1/auth/refresh').set('Cookie', refreshCookie).send({});
    expect(refreshed.status).toBe(200);

    // And the reissued token carries the reduced grant, not the old one.
    const newCookie = extractCookie(refreshed, 'accessToken');
    const after = await request(app).get('/api/v1/products?page=1&limit=5').set('Cookie', newCookie);
    expect(after.status).toBe(403);
  });
});

describe('effective permissions', () => {
  // Administration > Roles shows role rows, but the `users.role` column grants
  // permissions from code rather than from a row — which is how ORG_ADMIN came
  // to hold the whole catalog invisibly. This view names the source.
  it('separates what comes from the system role from what comes from each role', async () => {
    const { user, group } = await createUserReturning('effective@rbac.test', ['PRODUCT_READ', 'SALES_READ']);

    const res = await request(app)
      .get(`/api/v1/roles/effective-permissions/${user.id}`)
      .set('Cookie', adminCookie);

    expect(res.status).toBe(200);
    const { systemRole, fromSystemRole, roles, effective } = res.body.data;

    expect(systemRole).toBe('EMPLOYEE');
    expect(fromSystemRole).toEqual([]); // EMPLOYEE grants nothing on its own
    expect(roles.find((r) => r.id === group.id).permissions).toEqual(
      expect.arrayContaining(['PRODUCT_READ', 'SALES_READ'])
    );
    expect(effective).toEqual(expect.arrayContaining(['PRODUCT_READ', 'SALES_READ']));
  });

  it('shows an inactive role as carrying nothing effective', async () => {
    const { user, group } = await createUserReturning('effective2@rbac.test', ['PRODUCT_READ']);
    await group.update({ status: 'inactive' });

    const res = await request(app)
      .get(`/api/v1/roles/effective-permissions/${user.id}`)
      .set('Cookie', adminCookie);

    const listed = res.body.data.roles.find((r) => r.id === group.id);
    expect(listed.applied).toBe(false);
    expect(res.body.data.effective).not.toContain('PRODUCT_READ');
  });

  it('surfaces the system role grant that used to be invisible', async () => {
    const { user } = await createUserReturning('orgadmin@rbac.test', []);
    await user.update({ role: 'ORG_ADMIN' });

    const res = await request(app)
      .get(`/api/v1/roles/effective-permissions/${user.id}`)
      .set('Cookie', adminCookie);

    expect(res.body.data.fromSystemRole).toEqual(expect.arrayContaining(['ROLE_CREATE', 'EMPLOYEE_CREATE']));
    // Narrowed: an organisation administrator is no longer a silent superuser.
    expect(res.body.data.fromSystemRole).not.toContain('MIGRATION_RUN');
    expect(res.body.data.fromSystemRole).not.toContain('PURCHASE_APPROVE');
  });

  it('refuses the view without both grants', async () => {
    const { user } = await createUserReturning('effective3@rbac.test', []);
    const roleOnlyCookie = await createUserWithPermissions('roleonly@rbac.test', ['ROLE_READ']);

    const res = await request(app)
      .get(`/api/v1/roles/effective-permissions/${user.id}`)
      .set('Cookie', roleOnlyCookie);
    expect(res.status).toBe(403);
  });
});

describe('a Masters-only user sees only Masters', () => {
  // Reported from real use: an employee granted one Masters permission could
  // still see the Dashboard's figures, the Contractor & Labour module and the
  // whole tenant's alerts.
  let mastersCookie;

  beforeAll(async () => {
    mastersCookie = await createUserWithPermissions('mastersonly@rbac.test', ['PARTY_READ']);
  });

  it('is refused the workforce module the API never granted', async () => {
    // The sidebar gate used to include PARTY_READ, so Masters lit up Contractor
    // & Labour — but the API asks for CONTRACTOR_READ/LABOUR_READ, so the page
    // opened onto nothing but errors.
    const res = await request(app)
      .get('/api/v1/workforce/contractor/production-entries?page=1&limit=5')
      .set('Cookie', mastersCookie);
    expect(res.status).toBe(403);
  });

  it('gets a dashboard with no production, dispatch, sales or stock figures', async () => {
    const res = await request(app).get('/api/v1/dashboard/stats').set('Cookie', mastersCookie);
    expect(res.status).toBe(200);

    const { operational, financial } = res.body.data;
    for (const key of [
      'productionToday', 'productionMTD', 'dispatchesToday', 'pendingOrders',
      'curingLots', 'deadStockLots', 'slowMovingLots', 'reorderAlerts',
      'curingCompletingThisWeek', 'pendingVarianceApprovals',
      'rejectionPercent', 'yieldPercent',
    ]) {
      expect(operational).not.toHaveProperty(key);
    }
    // Their own unread count is personal and stays.
    expect(operational).toHaveProperty('unreadAlerts');
    // Money was already withheld without VIEW_RATES.
    expect(financial).toBeUndefined();
  });

  it('does not receive broadcast alerts about modules they cannot open', async () => {
    await Notification.create({
      tenantId, type: 'CREDIT_LIMIT_BREACH', severity: 'HIGH',
      title: 'Customer over limit', message: 'broadcast', userId: null, dedupeKey: 'k-credit-masters',
    });
    await Notification.create({
      tenantId, type: 'DEAD_STOCK', severity: 'MEDIUM',
      title: 'Dead stock', message: 'broadcast', userId: null, dedupeKey: 'k-dead-masters',
    });

    const res = await request(app)
      .get('/api/v1/notifications?page=1&limit=50')
      .set('Cookie', mastersCookie);
    expect(res.status).toBe(200);

    const titles = res.body.data.rows.map((n) => n.title);
    expect(titles).not.toContain('Customer over limit'); // needs SALES_READ
    expect(titles).not.toContain('Dead stock');          // needs INVENTORY_READ
  });

  it('still delivers an alert addressed to them personally', async () => {
    // Personal alerts are raised for a named user and must not need a module
    // grant, or an approval request could never reach its approver.
    const { user, cookie } = await createUserReturning('personal@rbac.test', ['PARTY_READ']);
    await Notification.create({
      tenantId, type: 'CREDIT_LIMIT_BREACH', severity: 'HIGH',
      title: 'Addressed to you', message: 'personal', userId: user.id, dedupeKey: 'k-personal-masters',
    });

    const res = await request(app).get('/api/v1/notifications?page=1&limit=50').set('Cookie', cookie);
    expect(res.body.data.rows.map((n) => n.title)).toContain('Addressed to you');
  });

  it('still shows the figures to someone who holds those grants', async () => {
    const opsCookie = await createUserWithPermissions('opsuser@rbac.test', [
      'PRODUCTION_READ', 'INVENTORY_READ', 'SALES_READ', 'DISPATCH_READ',
    ]);
    const res = await request(app).get('/api/v1/dashboard/stats').set('Cookie', opsCookie);

    expect(res.status).toBe(200);
    for (const key of ['productionToday', 'dispatchesToday', 'pendingOrders', 'curingLots']) {
      expect(res.body.data.operational).toHaveProperty(key);
    }
  });
});
