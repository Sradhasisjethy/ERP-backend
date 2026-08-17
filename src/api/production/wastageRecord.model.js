const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Product } = require('../products/product.model');
const { StockLot } = require('../inventory/stockLot.model');
const { ProductionEntry } = require('./productionEntry.model');

/**
 * M11: breakage/wastage at demoulding, stacking, handling, or in transit —
 * "must be recorded, not silently absorbed." When lotId is set, this posts a
 * BREAKAGE_OUT ledger entry against that lot (real stock, physically lost).
 * When it isn't (e.g. loss discovered before the batch was ever lotted),
 * it's a record only — there's no tracked stock to debit.
 */
class WastageRecord extends BaseAuditedModel {}

WastageRecord.initAudited(
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
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    lotId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    productionEntryId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    stage: {
      type: DataTypes.ENUM('DEMOULDING', 'STACKING', 'HANDLING', 'TRANSIT'),
      allowNull: false,
    },
    quantity: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    recordedDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'wastage_records',
  }
);

WastageRecord.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
WastageRecord.belongsTo(StockLot, { as: 'lot', foreignKey: 'lotId' });
WastageRecord.belongsTo(ProductionEntry, { as: 'productionEntry', foreignKey: 'productionEntryId' });

module.exports = { WastageRecord };
