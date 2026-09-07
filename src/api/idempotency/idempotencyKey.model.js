const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/** See migrations/20260909000000-idempotency-keys.js for why this exists. */
class IdempotencyKey extends BaseScopedModel {}

IdempotencyKey.initScoped(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    key: { type: DataTypes.STRING(200), allowNull: false },
    endpoint: { type: DataTypes.STRING(300), allowNull: false },
    requestHash: { type: DataTypes.STRING(64), allowNull: false },
    status: { type: DataTypes.ENUM('IN_PROGRESS', 'COMPLETED'), allowNull: false, defaultValue: 'IN_PROGRESS' },
    statusCode: { type: DataTypes.INTEGER, allowNull: true },
    responseBody: { type: DataTypes.JSONB, allowNull: true },
    userId: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'idempotency_keys' }
);

module.exports = { IdempotencyKey };
