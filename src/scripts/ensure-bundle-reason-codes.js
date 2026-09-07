/**
 * Seeds the default reasons a salesperson can give for taking an accessory off
 * an order. Idempotent — safe to run on every deploy.
 *
 *   npm run bundles:ensure-reasons
 *
 * Without at least one of these the removal button cannot work at all: the API
 * requires a reason code, deliberately, because a free-text box produces "not
 * needed" ten thousand times and answers nothing. These four are the answers
 * that actually call for different responses from the business — a customer who
 * already owns the item is a different problem from one who baulked at the
 * price.
 *
 * Tenants keep whatever they add or deactivate afterwards; this only fills in
 * codes that are missing.
 */
const { sequelize } = require('../config/database');
const { Tenant, OverrideReasonCode } = require('../models');

const DEFAULT_REASONS = [
  { code: 'ALREADY_HAS', label: 'Customer already has one', requiresNote: false },
  { code: 'TOO_EXPENSIVE', label: 'Too expensive', requiresNote: false },
  { code: 'NOT_NEEDED', label: 'Customer does not want it', requiresNote: false },
  // The only one that demands a note: on its own it says nothing.
  { code: 'OTHER', label: 'Other', requiresNote: true },
];

/**
 * Scoped by an explicit `where` rather than by tenant context, matching
 * ensure-default-roles.js: a script runs outside a request, so there is no CLS
 * tenant for the models to pick up.
 */
const ensureForTenant = async (tenantId) => {
  const existing = new Set(
    (await OverrideReasonCode.findAll({ where: { tenantId }, attributes: ['code'] })).map((r) => r.code)
  );
  const missing = DEFAULT_REASONS.filter((r) => !existing.has(r.code));

  // An existing code is never modified — someone may have reworded a label or
  // deactivated one deliberately.
  if (missing.length) await OverrideReasonCode.bulkCreate(missing.map((r) => ({ ...r, tenantId })));
  return missing.length;
};

const run = async () => {
  const tenants = await Tenant.findAll({ attributes: ['id', 'name'] });

  for (const tenant of tenants) {
    const added = await ensureForTenant(tenant.id);
    console.log(`${tenant.name}: ${added ? `added ${added} reason code(s)` : 'already up to date'}`);
  }
};

if (require.main === module) {
  run()
    .then(() => sequelize.close())
    .then(() => process.exit(0))
    .catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
}

module.exports = { run, ensureForTenant, DEFAULT_REASONS };
