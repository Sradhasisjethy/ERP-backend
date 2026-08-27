const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Product } = require('../products/product.model');
const { StockLot } = require('../inventory/stockLot.model');
const { GoodsReceipt } = require('../purchasing/goodsReceipt.model');
const { ProductionEntry } = require('../production/productionEntry.model');

/**
 * A single quality test and its verdict (QC-01).
 *
 * One row is one test, not one lot: a 7-day and a 28-day cube against the same
 * pour are two rows, which is what makes a strength curve expressible without
 * a schema change. `testedValue` and `requiredValue` are both stored so that
 * revising a specification later cannot silently rewrite the verdict on a test
 * taken last year.
 */
class QualityInspection extends BaseAuditedModel {}

QualityInspection.initAudited(
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
    inspectionNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    inspectionType: {
      type: DataTypes.ENUM('INCOMING', 'IN_PROCESS', 'FINAL'),
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    lotId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    goodsReceiptId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    productionEntryId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    testAgeDays: {
      type: DataTypes.INTEGER,
      allowNull: true,
    },
    sampleRef: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    testedValue: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: true,
    },
    requiredValue: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: true,
    },
    unitLabel: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    result: {
      type: DataTypes.ENUM('PENDING', 'PASS', 'FAIL'),
      allowNull: false,
      defaultValue: 'PENDING',
    },
    quantityInspected: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: true,
    },
    quantityRejected: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
      defaultValue: 0,
    },
    inspectionDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    recordedOn: {
      type: DataTypes.DATE,
      allowNull: true,
    },
    remarks: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    inspectedBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'quality_inspections',
  }
);

QualityInspection.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
QualityInspection.belongsTo(StockLot, { as: 'lot', foreignKey: 'lotId' });
QualityInspection.belongsTo(GoodsReceipt, { as: 'goodsReceipt', foreignKey: 'goodsReceiptId' });
QualityInspection.belongsTo(ProductionEntry, { as: 'productionEntry', foreignKey: 'productionEntryId' });
StockLot.hasMany(QualityInspection, { as: 'inspections', foreignKey: 'lotId' });

module.exports = { QualityInspection };
