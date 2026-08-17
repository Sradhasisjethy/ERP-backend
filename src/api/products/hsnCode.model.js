const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

class HsnCode extends BaseScopedModel {}

HsnCode.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    description: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    gstRatePercent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0,
    },
    status: {
      type: DataTypes.ENUM('active', 'inactive'),
      defaultValue: 'active',
    },
  },
  {
    sequelize,
    // D2: optimistic locking — a save from a stale form is rejected
    // rather than silently overwriting a concurrent edit.
    version: 'lockVersion',
    tableName: 'hsn_codes',
  }
);

module.exports = { HsnCode };
