const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

class ProductCategory extends BaseScopedModel {}

ProductCategory.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    parentId: {
      type: DataTypes.UUID,
      allowNull: true,
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
    tableName: 'product_categories',
  }
);

ProductCategory.belongsTo(ProductCategory, { as: 'parentCategory', foreignKey: 'parentId' });
ProductCategory.hasMany(ProductCategory, { as: 'subCategories', foreignKey: 'parentId' });

module.exports = { ProductCategory };
