const { BaseScopedModel } = require('./BaseModel');
const { getTenantId, getUserId, getIp } = require('./tenantContext');

/**
 * Extends BaseScopedModel with automatic audit-trail rows on create/update
 * (BR-30: every create, update, cancel and approval records user, timestamp, IP
 * and a before/after value snapshot). Cancel/approve are just status updates
 * made through `.update()`, so they're covered by the same afterUpdate hook —
 * there is deliberately no special-casing for them.
 *
 * Only used by transactional/master models introduced from Phase 1 onward.
 * Existing models (User, Organization, ...) are intentionally left on plain
 * BaseScopedModel — retrofitting them is out of scope here.
 */
class BaseAuditedModel extends BaseScopedModel {
  static initAudited(attributes, options) {
    const { hooks: modelHooks, auditExclude: modelAuditExclude, ...restOptions } = options;
    const auditExclude = new Set(['tenantId', ...(modelAuditExclude || [])]);
    const ModelRef = this;

    const sanitize = (obj) => {
      if (!obj) return obj;
      const clone = { ...obj };
      auditExclude.forEach((key) => delete clone[key]);
      return clone;
    };

    const recordAudit = async (action, entityId, before, after, options) => {
      const tenantId = getTenantId();
      // No tenant context (e.g. seed scripts running outside a request) — skip
      // rather than fail the write the audit trail is secondary to.
      if (!tenantId) return;

      const { AuditLog } = require('../api/audit/auditLog.model');
      await AuditLog.create(
        {
          tenantId,
          userId: getUserId() || null,
          ipAddress: getIp() || null,
          entityType: ModelRef.name,
          entityId,
          action,
          beforeSnapshot: before,
          afterSnapshot: after,
        },
        { transaction: options && options.transaction }
      );
    };

    this.initScoped(attributes, {
      ...restOptions,
      hooks: {
        afterCreate: async (instance, options) => {
          await recordAudit('CREATE', instance.id, null, sanitize(instance.toJSON()), options);
        },
        afterUpdate: async (instance, options) => {
          const changedFields = instance.changed() || [];
          if (!changedFields.length) return;
          const before = {};
          const after = {};
          changedFields.forEach((field) => {
            before[field] = instance._previousDataValues[field];
            after[field] = instance.dataValues[field];
          });
          await recordAudit('UPDATE', instance.id, sanitize(before), sanitize(after), options);
        },
        ...(modelHooks || {}),
      },
    });
  }
}

module.exports = { BaseAuditedModel };
