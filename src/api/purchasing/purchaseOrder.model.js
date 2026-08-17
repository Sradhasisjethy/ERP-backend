const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

class PurchaseOrder extends BaseAuditedModel {}

PurchaseOrder.initAudited(
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
    poNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    vendorPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    orderDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('DRAFT', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'DRAFT',
    },
    totalAmountPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    cancelReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    cancelledAt: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    // D2: optimistic locking — a save from a stale form is rejected
    // rather than silently overwriting a concurrent edit.
    version: 'lockVersion',
    tableName: 'purchase_orders',
  }
);

PurchaseOrder.belongsTo(Party, { as: 'vendor', foreignKey: 'vendorPartyId' });

module.exports = { PurchaseOrder };
