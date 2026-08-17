const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');
const { StockLot } = require('./stockLot.model');
const { Product } = require('../products/product.model');

/**
 * Immutable stock movement record (BR-01: every movement — in, out, transfer,
 * adjustment, breakage — creates an entry; no movement may bypass it. BR-05:
 * once posted, never edited or deleted — corrections are a reversing entry
 * referencing the original). Extends BaseScopedModel, not BaseAuditedModel:
 * there is no update hook to wire up because nothing here is ever updated.
 * All writes go through stockLedger.service.js — that's what BR-01 actually
 * means in code: no other module touches this table directly.
 */
class StockLedgerEntry extends BaseScopedModel {}

StockLedgerEntry.initScoped(
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
      allowNull: false,
    },
    movementType: {
      type: DataTypes.ENUM(
        'PRODUCTION_IN',
        'PRODUCTION_OUT',
        'PURCHASE_IN',
        'TRANSFER_OUT',
        'TRANSFER_IN',
        'SALE_OUT',
        'BREAKAGE_OUT',
        'ADJUSTMENT_IN',
        'ADJUSTMENT_OUT',
        'RETURN_IN',
        'RETURN_OUT',
        'CONTRACTOR_ISSUE_OUT',
        'CONTRACTOR_ISSUE_IN',
        'REVERSAL'
      ),
      allowNull: false,
    },
    direction: {
      type: DataTypes.ENUM('IN', 'OUT'),
      allowNull: false,
    },
    quantity: {
      // Always positive; direction carries the sign.
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    referenceType: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    referenceId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    reversalOfEntryId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    // BR-04: negative stock is blocked by default; when a factory explicitly
    // allows it, every occurrence must still raise an alert. This flag is
    // what a future alert/report scans for (M37) without needing its own table.
    isNegativeStockEvent: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    notes: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    createdBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'stock_ledger_entries',
    updatedAt: false,
  }
);

StockLedgerEntry.belongsTo(StockLot, { as: 'lot', foreignKey: 'lotId' });
StockLedgerEntry.belongsTo(Product, { as: 'product', foreignKey: 'productId' });

module.exports = { StockLedgerEntry };
