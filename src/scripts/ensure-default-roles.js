/**
 * Creates any missing default roles for existing tenants.
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
 *   - A role that already exists by name is NEVER modified. Someone may have
 *     tuned its grants deliberately, and silently rewriting that is exactly the
 *     kind of "helpful" behaviour that loses people access mid-shift.
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
const { DEFAULT_ROLES } = require('../constants/defaultRoles');
const { isKnownPermission } = require('../utils/permissionCatalog');

const arg = (name) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : null;
};
const hasFlag = (name) => process.argv.includes(`--${name}`);

const run = async () => {
  const dryRun = hasFlag('dry-run');
  const tenantId = arg('tenant');

  // Refuse to write anything if a grant in the file is not in the catalog —
  // an unknown permission is silently inert, which is worse than an error.
  const unknown = DEFAULT_ROLES.flatMap((r) =>
    r.permissions.filter((p) => p !== '*' && !isKnownPermission(p)).map((p) => `${r.name}: ${p}`)
  );
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
  let skipped = 0;

  for (const tenant of tenants) {
    // AdGroup is tenant-scoped through CLS, which this script runs outside of,
    // so the tenant filter is explicit here.
    const existing = await AdGroup.findAll({ where: { tenantId: tenant.id }, attributes: ['name'] });
    const existingNames = new Set(existing.map((r) => r.name));

    const missing = DEFAULT_ROLES.filter((r) => !existingNames.has(r.name));
    console.log(`${tenant.name} (${tenant.id})`);

    if (!missing.length) {
      console.log('  nothing to do — every default role already exists\n');
      skipped += DEFAULT_ROLES.length;
      continue;
    }

    for (const role of missing) {
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
    }
    skipped += DEFAULT_ROLES.length - missing.length;
    console.log('');
  }

  console.log(
    dryRun
      ? `[dry run] would create ${created} role(s); ${skipped} already present. Nothing was written.`
      : `Created ${created} role(s); ${skipped} already present and left untouched.`
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
