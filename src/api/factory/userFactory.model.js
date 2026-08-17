const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/**
 * Join table scoping a user's access to specific factories (BR-29). Consumed
 * by core/factoryAccess.js, not queried directly by most services.
 */
class UserFactory extends BaseScopedModel {}

UserFactory.initScoped(
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
