const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Product } = require('../products/product.model');
const { StockLot } = require('./stockLot.model');

/**
 * A recorded physical-count correction.
 *
 * This document does not itself move stock — StockLedgerService.postEntry
 * does, exactly as it does for a receipt or a dispatch, so an adjustment is
 * subject to the same lot locking, the same negative-stock rule and the same
 * ledger-versus-balance reconciliation as every other movement. What this row
 * adds is the explanation: what the system believed, what was actually counted,
 * the resulting difference, who counted it and why.
 *
 * Adjustments are never edited or deleted. A wrong adjustment is corrected by
 * making another one, which is what keeps the ledger append-only (BR-05).
 */
class StockAdjustment extends BaseAuditedModel {}

StockAdjustment.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    factoryId: { type: DataTypes.UUID, allowNull: false },
    productId: { type: DataTypes.UUID, allowNull: false },
    lotId: { type: DataTypes.UUID, allowNull: false },
    adjustmentNumber: { type: DataTypes.STRING, allowNull: false },
    adjustmentDate: { type: DataTypes.DATEONLY, allowNull: false },

    /** What the system held before the count. */
    previousQty: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    /** What the warehouse actually counted. */
    countedQty: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    /** counted − previous. Negative is a shortfall, positive is a surplus. */
    adjustmentQty: { type: DataTypes.DECIMAL(14, 4), allowNull: false },
    /** The lot quantity after posting — equal to countedQty, stored so the
     *  row reads as a complete statement without recomputation. */
    newQty: { type: DataTypes.DECIMAL(14, 4), allowNull: false },

    reason: { type: DataTypes.TEXT, allowNull: false },
    stockLedgerEntryId: { type: DataTypes.UUID, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
  },
  {
    sequelize,
    tableName: 'stock_adjustments',
  }
);

StockAdjustment.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
StockAdjustment.belongsTo(StockLot, { as: 'lot', foreignKey: 'lotId' });

module.exports = { StockAdjustment };
