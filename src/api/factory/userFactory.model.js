const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');

/**
 * Join table scoping a user's access to specific factories (BR-29). Consumed
 * by core/factoryAccess.js, not queried directly by most services.
 *
 * Audited, not merely scoped: who may see which plant is the most
 * access-relevant assignment after roles, so granting and revoking it must
 * leave a trail (actor, IP, timestamp ride in from the CLS audit context).
 */
class UserFactory extends BaseAuditedModel {}

UserFactory.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    factoryId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'user_factories',
  }
);

module.exports = { UserFactory };
