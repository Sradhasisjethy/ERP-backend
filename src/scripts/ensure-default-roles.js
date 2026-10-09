/**
 * Creates any missing default roles for existing tenants, and tops up the
 * existing ones with grants introduced since they were seeded.
 *
 * `npm run seed` builds a demo tenant from scratch and is not something you run
 * against live data. This script exists for the case that actually matters: a
 * tenant that already has users and documents, and whose roles predate the
 * operational permissions (production, quality, vehicles, inventory, sales,
 * purchase) — so every one of those screens returns 403 for anyone who is not
 * Platform Admin or Tenant Owner.
 *
 * It is deliberately conservative:
 *
 *   - A role that already exists by name is only ever ADDED to, and only with
 *     the codes listed in LATER_GRANTS (constants/defaultRoles.js) — grants
 *     that did not exist when the role was seeded, such as INVOICE_CANCEL after
 *     cancelling moved off INVOICE_MODIFY. Nothing an administrator added is
 *     removed, and a default code an administrator took away is not put back.
 *   - A cancel code is added only while the role still holds the grant that
 *     used to perform that cancel, so the split changes nothing on day one.
 *     Re-running it re-adds a cancel code an administrator removed *while
 *     leaving the matching *_MODIFY in place*; take both away to make it stick.
 *   - Members of a topped-up role have their tokens refreshed (permission
 *     version bump), so the new codes apply at once rather than within the hour.
 *   - Nothing is deleted, and no user is reassigned. Creating a role grants
 *     nobody anything until an administrator puts someone in it.
 *
 * Usage:
 *   node src/scripts/ensure-default-roles.js              # every tenant
 *   node src/scripts/ensure-default-roles.js --dry-run    # show, change nothing
 *   node src/scripts/ensure-default-roles.js --tenant=<id>
 */
const { sequelize } = require('../config/database');
const { Tenant, AdGroup } = require('../models');
const { DEFAULT_ROLES, LATER_GRANTS } = require('../constants/defaultRoles');
const { isKnownPermission, expandPermissions, holdsPermission } = require('../utils/permissionCatalog');
const { bumpRoleMembers } = require('../utils/permissionVersion');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : null;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

/** The LATER_GRANTS codes the default definition gives this role and the row lacks. */
const topUpFor = (row, definition) => {
  const stored = row.permissions || [];
  const effective = expandPermissions(stored);
  const add = [];
  const held = [];
  for (const code of definition.permissions) {
    const rule = LATER_GRANTS[code];
    if (!rule || stored.includes(code) || holdsPermission(effective, code)) continue;
    if (rule.ifHolds && !rule.ifHolds.some((pre) => holdsPermission(effective, pre))) {
      held.push(`${code} (role no longer holds ${rule.ifHolds.join('/')})`);
      continue;
    }
    add.push(code);
  }
  return { add, held };
};

const run = async () => {
  const dryRun = hasFlag('dry-run');
  const tenantId = arg('tenant');

  // Refuse to write anything if a grant in the file is not in the catalog —
  // an unknown permission is silently inert, which is worse than an error.
  const unknown = DEFAULT_ROLES.flatMap((r) =>
    r.permissions.filter((p) => p !== '*' && !isKnownPermission(p)).map((p) => `${r.name}: ${p}`)
  ).concat(Object.keys(LATER_GRANTS).filter((p) => !isKnownPermission(p)).map((p) => `LATER_GRANTS: ${p}`));
  if (unknown.length) {
    console.error('Refusing to run — unknown permissions in defaultRoles.js:');
    unknown.forEach((u) => console.error(`  ${u}`));
    process.exitCode = 1;
    return;
  }

  await sequelize.authenticate();

  const tenants = tenantId
    ? await Tenant.findAll({ where: { id: tenantId } })
    : await Tenant.findAll();

  if (!tenants.length) {
    console.log(tenantId ? `No tenant found with id ${tenantId}` : 'No tenants found.');
    return;
  }

  console.log(`${dryRun ? '[dry run] ' : ''}Checking ${tenants.length} tenant(s) against ${DEFAULT_ROLES.length} default roles.\n`);

  let created = 0;
  let toppedUp = 0;
  let untouched = 0;

  for (const tenant of tenants) {
    // AdGroup is tenant-scoped through CLS, which this script runs outside of,
    // so the tenant filter is explicit here.
    const existing = await AdGroup.findAll({ where: { tenantId: tenant.id }, attributes: ['id', 'name', 'permissions'] });
    const byName = new Map(existing.map((r) => [r.name, r]));
    console.log(`${tenant.name} (${tenant.id})`);

    let changed = false;
    for (const role of DEFAULT_ROLES) {
      const row = byName.get(role.name);

      if (!row) {
        console.log(`  + ${role.name} (${role.permissions.length} grants)`);
        if (!dryRun) {
          await AdGroup.create({
            tenantId: tenant.id,
            name: role.name,
            description: role.description,
            permissions: role.permissions,
            status: 'active',
          });
        }
        created += 1;
        changed = true;
        continue;
      }

      const { add, held } = topUpFor(row, role);
      held.forEach((note) => console.log(`  = ${role.name}: not adding ${note}`));
      if (!add.length) {
        untouched += 1;
        continue;
      }

      console.log(`  ^ ${role.name}: adding ${add.join(', ')}`);
      if (!dryRun) {
        await sequelize.transaction(async (transaction) => {
          // Re-read inside the transaction so an edit made since the listing
          // above is added to, not overwritten.
          const fresh = await AdGroup.findByPk(row.id, { transaction, lock: transaction.LOCK.UPDATE });
          const current = fresh.permissions || [];
          await fresh.update({ permissions: [...current, ...add.filter((code) => !current.includes(code))] }, { transaction });
          await bumpRoleMembers(fresh.id, transaction);
        });
      }
      toppedUp += 1;
      changed = true;
    }
    console.log(changed ? '' : '  nothing to do — every default role exists and is up to date\n');
  }

  console.log(
    dryRun
      ? `[dry run] would create ${created} role(s) and top up ${toppedUp}; ${untouched} already up to date. Nothing was written.`
      : `Created ${created} role(s), topped up ${toppedUp}; ${untouched} already up to date and left untouched.`
  );
  if (created && !dryRun) {
    console.log('\nNobody gains access until an administrator assigns someone to a role.');
    console.log('Administration > Roles & Permissions.');
  }
};

run()
  .catch((err) => {
    console.error('Failed:', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sequelize.close();
  });
