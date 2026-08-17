const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { GoodsReceipt } = require('./goodsReceipt.model');
const { Product } = require('../products/product.model');
const { PurchaseOrderLine } = require('./purchaseOrderLine.model');

class GoodsReceiptLine extends BaseAuditedModel {}

GoodsReceiptLine.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    goodsReceiptId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    purchaseOrderLineId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    receivedQty: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    ratePaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    lotId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'goods_receipt_lines',
  }
);

GoodsReceiptLine.belongsTo(GoodsReceipt, { as: 'goodsReceipt', foreignKey: 'goodsReceiptId' });
GoodsReceiptLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
GoodsReceiptLine.belongsTo(PurchaseOrderLine, { as: 'purchaseOrderLine', foreignKey: 'purchaseOrderLineId' });
GoodsReceipt.hasMany(GoodsReceiptLine, { as: 'lines', foreignKey: 'goodsReceiptId' });

module.exports = { GoodsReceiptLine };
