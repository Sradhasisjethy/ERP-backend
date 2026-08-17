const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { PurchaseOrder } = require('./purchaseOrder.model');
const { Product } = require('../products/product.model');

class PurchaseOrderLine extends BaseAuditedModel {}

PurchaseOrderLine.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    purchaseOrderId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    orderedQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    ratePaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    receivedQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'purchase_order_lines',
  }
);

PurchaseOrderLine.belongsTo(PurchaseOrder, { as: 'purchaseOrder', foreignKey: 'purchaseOrderId' });
PurchaseOrderLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
PurchaseOrder.hasMany(PurchaseOrderLine, { as: 'lines', foreignKey: 'purchaseOrderId' });

module.exports = { PurchaseOrderLine };
