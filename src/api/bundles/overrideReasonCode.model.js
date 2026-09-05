const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/**
 * Why a salesperson took an accessory off an order.
 *
 * A free-text box would produce "not needed" ten thousand times and answer
 * nothing. A short controlled list is what makes the attach-rate report worth
 * reading: "customer already has one" and "too expensive" call for completely
 * different responses from the business.
 *
 * The code is unique *within a tenant*, not globally — it started out as the
 * primary key, which made ALREADY_HAS claimable by exactly one tenant on the
 * whole platform. See migration 20260910000000.
 */
class OverrideReasonCode extends BaseScopedModel {}

OverrideReasonCode.initScoped(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    // Uppercase, stable, and what appears on every suppression row and report
    // grouping — but scoped to the tenant by a unique (tenantId, code) index.
    code: { type: DataTypes.STRING(50), allowNull: false },
    label: { type: DataTypes.STRING(200), allowNull: false },
    // For reasons that mean nothing on their own — OTHER, chiefly.
    requiresNote: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
  },
  { sequelize, tableName: 'override_reason_codes' }
);

module.exports = { OverrideReasonCode };
