/**
 * Reports every user whose BR-29 access scope is missing or inconsistent,
 * tenant by tenant. Read-only: it changes nothing, assigns nothing, and never
 * guesses a default — which plant a person belongs to is an administrative
 * decision, so the output is a worklist for the Edit User screen (or
 * POST /factories/:id/users), not an input to an automatic backfill.
 *
 * A user is listed when any of these hold:
 *
 *   1. No factory assignment and not an unrestricted role — every scoped list
 *      answers them with nothing, which is safe but almost never intended.
 *   2. No organisation — factories cannot be validated against an organisation
 *      the user does not have.
 *   3. Assigned to a factory of a different organisation than their own — the
 *      two scopes disagree; the user editor now refuses to save this state,
 *      but rows written before the rule are reported here.
 *
 * Usage: node src/scripts/report-unscoped-users.js
 */
require('dotenv').config();
const { sequelize } = require('../config/database');
const { Tenant, User, Organization, Factory, UserFactory } = require('../models');
const { FACTORY_BYPASS_ROLES } = require('../core/factoryAccess');

const main = async () => {
  const tenants = await Tenant.unscoped().findAll({ attributes: ['id', 'name'], order: [['name', 'ASC']] });
  let flagged = 0;

  for (const tenant of tenants) {
    const [users, orgs, factories, assignments] = await Promise.all([
      User.unscoped().findAll({
        where: { tenantId: tenant.id },
        attributes: ['id', 'email', 'firstName', 'lastName', 'role', 'status', 'organizationId'],
        order: [['email', 'ASC']],
      }),
      Organization.unscoped().findAll({ where: { tenantId: tenant.id }, attributes: ['id', 'name'] }),
      Factory.unscoped().findAll({ where: { tenantId: tenant.id }, attributes: ['id', 'name', 'organizationId'] }),
      UserFactory.unscoped().findAll({ where: { tenantId: tenant.id }, attributes: ['userId', 'factoryId'] }),
    ]);

    const orgName = new Map(orgs.map((o) => [o.id, o.name]));
    const factoryById = new Map(factories.map((f) => [f.id, f]));
    const byUser = new Map();
    for (const a of assignments) {
      if (!byUser.has(a.userId)) byUser.set(a.userId, []);
      byUser.get(a.userId).push(a.factoryId);
    }

    const problems = [];
    for (const user of users) {
      if (user.status === 'INACTIVE' || user.status === 'TERMINATED') continue;
      const issues = [];
      const assigned = byUser.get(user.id) || [];
      const unrestricted = FACTORY_BYPASS_ROLES.includes(user.role);

      if (!unrestricted && assigned.length === 0) issues.push('no factory assignment (sees no plant data)');
      if (!user.organizationId) issues.push('no organisation');
      for (const factoryId of assigned) {
        const factory = factoryById.get(factoryId);
        if (!factory) issues.push(`assigned to missing factory ${factoryId}`);
        else if (user.organizationId && factory.organizationId !== user.organizationId) {
          issues.push(`assigned to "${factory.name}" of ${orgName.get(factory.organizationId) || 'another organisation'}, but belongs to ${orgName.get(user.organizationId) || 'their own'}`);
        }
      }

      if (issues.length) {
        problems.push({ user, issues, assigned: assigned.map((id) => factoryById.get(id)?.name || id) });
      }
    }

    if (!problems.length) continue;
    console.log(`\nTenant: ${tenant.name} (${tenant.id}) — ${problems.length} user(s) need attention`);
    for (const { user, issues, assigned } of problems) {
      flagged += 1;
      const name = `${user.firstName || ''} ${user.lastName || ''}`.trim();
      console.log(`  ${user.email} (${name || 'no name'}, ${user.role}, ${user.status})`);
      console.log(`    organisation: ${orgName.get(user.organizationId) || 'NONE'}; factories: ${assigned.join(', ') || 'NONE'}`);
      for (const issue of issues) console.log(`    - ${issue}`);
    }
  }

  console.log(flagged ? `\n${flagged} user(s) flagged. Fix via the Edit User screen; nothing was changed.` : 'All active users have a consistent organisation/factory scope.');
};

main()
  .catch((error) => {
    console.error('Report failed:', error);
    process.exitCode = 1;
  })
  .finally(() => sequelize.close());
