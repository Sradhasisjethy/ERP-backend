const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/**
 * Immutable audit trail (BR-30). Deliberately extends BaseScopedModel, not
 * BaseAuditedModel — an audited model that audits itself would recurse.
 */
class AuditLog extends BaseScopedModel {}

AuditLog.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    entityType: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    entityId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    action: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    beforeSnapshot: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    afterSnapshot: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    ipAddress: {
      type: DataTypes.STRING,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'audit_logs',
  }
);

module.exports = { AuditLog };
