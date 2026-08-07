const { Model, DataTypes } = require('sequelize');
const { getTenantId } = require('./tenantContext');

/**
 * Base class for tenant-scoped models. `beforeFind` / `beforeCreate` transparently
 * apply the current tenant (from CLS) so callers never have to filter by tenantId manually.
 * Note: `beforeUpdate`/`beforeDestroy` only affect bulk `Model.update()`/`Model.destroy()`
 * calls (they patch `options.where`) — instance-level `.update()`/`.destroy()` calls used
 * throughout this codebase bypass that `where` entirely. That's safe today because every
 * instance is first fetched via a tenant-scoped `findByPk`/`findOne`, but it means this
 * hook is not a substitute for scoping the initial lookup.
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
          beforeCreate: (instance) => {
            const tenantId = getTenantId();
            if (tenantId) {
              instance.tenantId = tenantId;
            }
          },
          beforeUpdate: (instance, options) => {
            const tenantId = getTenantId();
            if (tenantId) {
              options.where = { ...options.where, tenantId };
            }
          },
          beforeDestroy: (options) => {
            const tenantId = getTenantId();
            if (tenantId) {
              options.where = { ...options.where, tenantId };
            }
          },
          ...(modelHooks || {}),
        },
      }
    );
  }
}

module.exports = { BaseScopedModel };
