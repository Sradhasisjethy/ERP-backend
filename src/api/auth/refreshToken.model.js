const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/**
 * One row per live refresh token. See migration 20260912000000 for why.
 *
 * Only the token's `jti` is kept, never the token — the table is an allowlist,
 * not a store of credentials, and reading it grants nothing.
 */
class RefreshToken extends BaseScopedModel {}

RefreshToken.initScoped(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    jti: { type: DataTypes.UUID, allowNull: false },

    expiresAt: { type: DataTypes.DATE, allowNull: false },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    revokedReason: { type: DataTypes.STRING(50), allowNull: true },
    replacedBy: { type: DataTypes.UUID, allowNull: true },

    userAgent: { type: DataTypes.STRING(300), allowNull: true },
    ipAddress: { type: DataTypes.STRING(64), allowNull: true },
  },
  { sequelize, tableName: 'refresh_tokens' }
);

module.exports = { RefreshToken };
