const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { SalesReturn } = require('./salesReturn.model');
const { Product } = require('../products/product.model');
const { StockLot } = require('../inventory/stockLot.model');

class SalesReturnLine extends BaseAuditedModel {}

SalesReturnLine.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    salesReturnId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    quantity: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    ratePaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    createdLotId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'sales_return_lines',
  }
);

SalesReturnLine.belongsTo(SalesReturn, { as: 'salesReturn', foreignKey: 'salesReturnId' });
SalesReturnLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
SalesReturnLine.belongsTo(StockLot, { as: 'createdLot', foreignKey: 'createdLotId' });
SalesReturn.hasMany(SalesReturnLine, { as: 'lines', foreignKey: 'salesReturnId' });

module.exports = { SalesReturnLine };
