const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Organization } = require('../organization/organization.model');

/**
 * A physical production facility (BR-29 access is scoped per factory; BR-04
 * negative-stock permission and BR-21 cash-balance floor are configured here).
 */
class Factory extends BaseAuditedModel {}

Factory.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    organizationId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    address: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    city: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    state: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // BR-04: negative stock is blocked by default, permitted per-factory by
    // explicit configuration.
    allowNegativeStock: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // BR-21: factory cash balance may not go negative without override permission.
    allowNegativeCash: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    // BR-09: material consumption variance beyond this configurable threshold
    // requires supervisor approval. Any non-zero variance still requires a
    // reason regardless of this threshold.
    // QC-01: opt-in. While false the plant behaves exactly as before — a lot
    // finishing its curing period goes straight to AVAILABLE. While true, a
    // lot of a qcRequired product waits in QC_HOLD for a passing FINAL test.
    qcHoldEnabled: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    varianceThresholdPercent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 5.0,
    },
    // BR-14: dispatch quantity may not exceed ordered quantity plus this
    // configurable tolerance. Defaults to 0 (strict) — over-dispatch is risky
    // enough that a factory should opt into slack, not get it by default.
    dispatchTolerancePercent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: false,
      defaultValue: 0,
    },
    // M22 ageing thresholds (FR-M22-1). NULL means "inherit" — resolution
    // cascades Product -> Category -> Factory -> Global, most specific
    // non-null wins (FR-M03-5, AC-2.2). See inventory/ageing.service.js.
    slowMovingDays: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    deadStockDays: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    alertBeforeDays: {
      type: DataTypes.INTEGER,
      allowNull: true,
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
    tableName: 'factories',
  }
);

// The organisation a plant belongs to — its name and GSTIN head every printed
// document.
Factory.belongsTo(Organization, { as: 'organization', foreignKey: 'organizationId' });

module.exports = { Factory };