const { Model, DataTypes } = require('sequelize');
const { getTenantId } = require('./tenantContext');

/**
 * Base class for tenant-scoped models. `beforeFind` / `beforeValidate` transparently
 * apply the current tenant (from CLS) so callers never have to filter by tenantId manually.
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
