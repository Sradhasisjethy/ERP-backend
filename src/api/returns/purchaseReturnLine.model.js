const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { PurchaseReturn } = require('./purchaseReturn.model');
const { Product } = require('../products/product.model');

class PurchaseReturnLine extends BaseAuditedModel {}

PurchaseReturnLine.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    purchaseReturnId: {
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
  },
  {
    sequelize,
    tableName: 'purchase_return_lines',
  }
);

PurchaseReturnLine.belongsTo(PurchaseReturn, { as: 'purchaseReturn', foreignKey: 'purchaseReturnId' });
PurchaseReturnLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
PurchaseReturn.hasMany(PurchaseReturnLine, { as: 'lines', foreignKey: 'purchaseReturnId' });

module.exports = { PurchaseReturnLine };
