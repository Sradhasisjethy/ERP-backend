const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { StockTransfer } = require('./stockTransfer.model');
const { Product } = require('../products/product.model');
const { StockLot } = require('../inventory/stockLot.model');

class StockTransferLine extends BaseAuditedModel {}

StockTransferLine.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    stockTransferId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    sourceLotId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    quantity: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    // Recorded separately from `quantity` (not silently absorbed, per the
    // BRD's breakage principle) — a shortfall here means transit loss.
    receivedQuantity: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: true,
    },
    destinationLotId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'stock_transfer_lines',
  }
);

StockTransferLine.belongsTo(StockTransfer, { as: 'stockTransfer', foreignKey: 'stockTransferId' });
StockTransferLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
StockTransferLine.belongsTo(StockLot, { as: 'sourceLot', foreignKey: 'sourceLotId' });
StockTransferLine.belongsTo(StockLot, { as: 'destinationLot', foreignKey: 'destinationLotId' });
StockTransfer.hasMany(StockTransferLine, { as: 'lines', foreignKey: 'stockTransferId' });

module.exports = { StockTransferLine };
