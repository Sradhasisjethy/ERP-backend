const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/**
 * TenantSettings model.
 */
class TenantSettings extends BaseScopedModel {}

TenantSettings.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    key: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    value: {
      type: DataTypes.JSONB,
      allowNull: true,
    },
    category: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'general',
    },
  },
  {
    sequelize,
    tableName: 'tenant_settings',
    indexes: [{ unique: true, fields: ['tenantId', 'key'], name: 'tenant_settings_key_unique' }],
  }
);

module.exports = { TenantSettings };
