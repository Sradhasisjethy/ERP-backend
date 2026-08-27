const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { ProductCategory } = require('./productCategory.model');
const { Uom } = require('./uom.model');
const { HsnCode } = require('./hsnCode.model');

/**
 * A saleable finished good or a raw material consumed by mix designs.
 * curingDays drives BR-08 (a lot becomes AVAILABLE automatically once
 * production_date + curing_days is reached) and is only meaningful for
 * FINISHED_GOOD products.
 */
class Product extends BaseAuditedModel {}

Product.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    categoryId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    uomId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    hsnId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    code: {
      // SKU, unique per tenant (enforced at the DB level in the migration).
      type: DataTypes.STRING,
      allowNull: false,
    },
    productType: {
      type: DataTypes.ENUM('FINISHED_GOOD', 'RAW_MATERIAL'),
      defaultValue: 'FINISHED_GOOD',
    },
    // QC-01: does a produced lot of this product need a passing test before it
    // can be sold? Independent of curingDays, which is about age, not strength.
    qcRequired: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    curingDays: {
      type: DataTypes.INTEGER,
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
    // FR-M03-3: below this the dashboard raises a reorder alert (FR-M23-3).
    reorderLevel: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
      defaultValue: 0,
    },
    minStock: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: true,
    },
    maxStock: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: true,
    },
    standardCostPaise: {
      type: DataTypes.BIGINT,
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
    tableName: 'products',
  }
);

Product.belongsTo(ProductCategory, { as: 'category', foreignKey: 'categoryId' });
Product.belongsTo(Uom, { as: 'uom', foreignKey: 'uomId' });
Product.belongsTo(HsnCode, { as: 'hsnCode', foreignKey: 'hsnId' });

module.exports = { Product };
