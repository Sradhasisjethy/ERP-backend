const { Model, DataTypes } = require('sequelize');
const { getTenantId } = require('./tenantContext');

/**
 * Base class for tenant-scoped models. `beforeFind` / `beforeCount` /
 * `beforeValidate` transparently apply the current tenant (from CLS) so callers
 * never have to filter by tenantId manually.
 *
 * There are deliberately no beforeUpdate/beforeDestroy hooks here. Every call site in this
 * codebase fetches the instance via a tenant-scoped findByPk/findOne *before* calling
 * `.update()`/`.destroy()` on it, so the instance is already guaranteed to belong to the
 * current tenant by the time those run — an extra hook adds no real protection. It's also
 * actively dangerous to add one carelessly: beforeUpdate/beforeDestroy are *instance-level*
 * hooks with signature `(instance, options)`, not `(options)` like the bulk variants
 * (beforeBulkUpdate/beforeBulkDestroy). A hook declared with only one parameter silently
 * captures `instance` into it; writing `instance.where = {...}` shadows the instance's own
 * `where()` prototype method, which crashes Sequelize's internal `destroy()` with
 * "this.where is not a function" the moment it's called. That bug shipped in this file
 * for beforeDestroy until it was caught here.
 */
class BaseScopedModel extends Model {
  /**
   * `count()` fires `beforeCount`, but `sum()`, `min()` and `max()` fire NO
   * hook at all — they call `Model.aggregate` directly. So while findAll and
   * count were correctly tenant-scoped, `sum` silently answered across every
   * tenant on the platform:
   *
   *     findAll({ where: { status: 'CONFIRMED' } })          -> 1 row,  this tenant
   *     sum('totalAmountPaise', { where: { status: ... } })   -> both tenants' money
   *
   * That is how BR-13 credit control was computing a customer's exposure: one
   * tenant's order volume could block another tenant's customer, and a real
   * over-limit order could slip through. Overriding `aggregate` — which every
   * aggregate call including `count` funnels through — closes the whole family
   * at once rather than per call site.
   */
  static aggregate(attribute, aggregateFunction, options = {}) {
    const tenantId = getTenantId();
    if (tenantId) {
      options = { ...options, where: { ...options.where, tenantId } };
    }
    return super.aggregate(attribute, aggregateFunction, options);
  }

  static initScoped(attributes, options) {
    const { defaultScope: modelDefaultScope, hooks: modelHooks, ...restOptions } = options;

    // Merge (not overwrite) the model's own defaultScope attribute exclusions with
    // tenantId. A naive `{ ...options, defaultScope: { exclude: ['tenantId'] } }` here
    // would silently drop a model-specific exclusion — e.g. User excluding passwordHash —
    // which previously leaked password hashes on every unscoped User query.
    const modelExclude = (modelDefaultScope && modelDefaultScope.attributes && modelDefaultScope.attributes.exclude) || [];

    super.init(
      {
        ...attributes,
        tenantId: {
          type: DataTypes.UUID,
          allowNull: false,
        },
      },
      {
        ...restOptions,
        // D2 optimistic locking is opt-IN per model (pass
        // `version: 'lockVersion'`), not blanket, for two reasons:
        //
        //  - Rows the system mutates in bulk (StockLot via promoteEligibleLots
        //    / rebuildStockBalances, StockReservation via release) are changed
        //    with `Model.update(...)`, which does NOT bump the version counter.
        //    Any instance held across such a call becomes permanently stale and
        //    every later save throws — a self-inflicted outage, not a safeguard.
        //
        //  - Stock deduction already uses pessimistic locking (SELECT ... FOR
        //    UPDATE in StockLedgerService.postEntry), which is strictly stronger
        //    for the oversell case D2 actually cares about. Layering optimistic
        //    locking on top adds failure modes without adding protection.
        //
        // So it is enabled on records a human edits through a form, where two
        // people overwriting each other silently is the real risk.
        defaultScope: {
          ...modelDefaultScope,
          attributes: {
            ...(modelDefaultScope && modelDefaultScope.attributes),
            exclude: ['tenantId', ...modelExclude],
          },
        },
        hooks: {
          beforeFind: (options) => {
            const tenantId = getTenantId();
            if (tenantId) {
              options.where = { ...options.where, tenantId };
            }
          },
          // `count()` does NOT go through beforeFind — Sequelize routes it via
          // Model.aggregate, which fires `beforeCount` instead. Without this
          // hook every count in the codebase was answered across ALL tenants
          // while the findAll beside it was correctly scoped:
          //
          //     findAll({ where: { code: 'X' } })  -> 1 row   (this tenant)
          //     count(  { where: { code: 'X' } })  -> 2       (every tenant)
          //
          // That silently inflated the dashboard tiles (curing lots, dead
          // stock, pending approvals, unread notifications) with other
          // tenants' data, and it makes any "does this already exist?" or
          // "is this still referenced?" check answer about the wrong tenant.
          beforeCount: (options) => {
            const tenantId = getTenantId();
            if (tenantId) {
              options.where = { ...options.where, tenantId };
            }
          },
          // Must be beforeValidate, not beforeCreate: Sequelize runs its own
          // `allowNull: false` check on tenantId during validation, which happens
          // *before* beforeCreate fires. Setting it in beforeCreate was always too
          // late — every create() went through validation with a still-null
          // tenantId and failed, unless the caller passed tenantId explicitly (as
          // the seed script does) or disabled validation.
          beforeValidate: (instance) => {
            const tenantId = getTenantId();
            if (tenantId) {
              instance.tenantId = tenantId;
            }
          },
          ...(modelHooks || {}),
        },
      }
    );
  }
}

module.exports = { BaseScopedModel };
