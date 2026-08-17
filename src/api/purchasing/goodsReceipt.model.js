const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');
const { PurchaseOrder } = require('./purchaseOrder.model');

class GoodsReceipt extends BaseAuditedModel {}

GoodsReceipt.initAudited(
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
    grnNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    purchaseOrderId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    vendorPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    receiptDate: {
      type: DataTypes.DATEONLY,
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
    tableName: 'goods_receipts',
  }
);

GoodsReceipt.belongsTo(Party, { as: 'vendor', foreignKey: 'vendorPartyId' });
GoodsReceipt.belongsTo(PurchaseOrder, { as: 'purchaseOrder', foreignKey: 'purchaseOrderId' });

module.exports = { GoodsReceipt };
