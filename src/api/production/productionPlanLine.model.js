const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { ProductionPlan } = require('./productionPlan.model');
const { Product } = require('../products/product.model');

class ProductionPlanLine extends BaseAuditedModel {}

ProductionPlanLine.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    productionPlanId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    // Computed at proposal time: max(0, totalOpenOrderedQty - stockBalance).
    requiredQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    // What the human actually confirms to produce — defaults to requiredQty
    // but can be adjusted up/down before confirming (BR-12: "a human confirms it").
    confirmedQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'production_plan_lines',
  }
);

ProductionPlanLine.belongsTo(ProductionPlan, { as: 'productionPlan', foreignKey: 'productionPlanId' });
ProductionPlanLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
ProductionPlan.hasMany(ProductionPlanLine, { as: 'lines', foreignKey: 'productionPlanId' });

module.exports = { ProductionPlanLine };
