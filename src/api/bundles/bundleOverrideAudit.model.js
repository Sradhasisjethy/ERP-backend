const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/**
 * Append-only record of every deliberate departure from a bundle rule.
 *
 * This is what turns "the kit is not selling" from an opinion into a number:
 * which accessory, on whose order, for what stated reason. Phase 4 reads it as
 * the attach-rate report.
 *
 * It carries no foreign keys to the documents it describes, by design — an
 * audit row that disappears with the order it audits is not an audit. Rows are
 * written, never updated or deleted.
 */
class BundleOverrideAudit extends BaseScopedModel {}

BundleOverrideAudit.initScoped(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    salesOrderId: { type: DataTypes.UUID, allowNull: false },
    lineId: { type: DataTypes.UUID, allowNull: true },
    parentLineId: { type: DataTypes.UUID, allowNull: true },
    componentProductId: { type: DataTypes.UUID, allowNull: true },

    action: {
      type: DataTypes.ENUM('QTY_CHANGED', 'PRICE_CHANGED', 'SUPPRESSED', 'RESTORED', 'OPTIONAL_ADDED', 'RESET'),
      allowNull: false,
    },
    beforeValue: { type: DataTypes.JSONB, allowNull: true },
    afterValue: { type: DataTypes.JSONB, allowNull: true },
    reasonCode: { type: DataTypes.STRING(50), allowNull: true },
    reasonNote: { type: DataTypes.TEXT, allowNull: true },

    actorId: { type: DataTypes.UUID, allowNull: true },
    occurredAt: { type: DataTypes.DATE, allowNull: false, defaultValue: DataTypes.NOW },
  },
  { sequelize, tableName: 'bundle_override_audits' }
);

module.exports = { BundleOverrideAudit };
