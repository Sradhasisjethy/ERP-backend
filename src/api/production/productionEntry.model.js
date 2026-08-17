const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Product } = require('../products/product.model');
const { MixDesign } = require('../products/mixDesign.model');
const { ProductionPlanLine } = require('./productionPlanLine.model');
const { StockLot } = require('../inventory/stockLot.model');

/**
 * A casting run (BR-06): creates a finished-goods lot in CURING status and
 * simultaneously consumes raw materials per the active mix design — both in
 * the same transaction (production.service.js#createProductionEntry).
 * BR-10: rejectedQty is recorded here, not folded into goodQty — the lot
 * only ever holds goodQty.
 */
class ProductionEntry extends BaseAuditedModel {}

ProductionEntry.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    factoryId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    entryNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    mixDesignId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productionPlanLineId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    productionDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    goodQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    rejectedQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
      defaultValue: 0,
    },
    curingDays: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    lotId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('POSTED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'POSTED',
    },
    cancelReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'production_entries',
  }
);

ProductionEntry.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
ProductionEntry.belongsTo(MixDesign, { as: 'mixDesign', foreignKey: 'mixDesignId' });
ProductionEntry.belongsTo(ProductionPlanLine, { as: 'productionPlanLine', foreignKey: 'productionPlanLineId' });
ProductionEntry.belongsTo(StockLot, { as: 'lot', foreignKey: 'lotId' });

module.exports = { ProductionEntry };
