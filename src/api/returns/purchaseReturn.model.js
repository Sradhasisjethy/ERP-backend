const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/**
 * M22: goods sent back to a vendor. Consumes stock (FIFO by lot, BR-03) and
 * reduces what we owe the vendor via a Purchase Return posting (BR-18).
 */
class PurchaseReturn extends BaseAuditedModel {}

PurchaseReturn.initAudited(
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
    returnNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    vendorPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    returnDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('POSTED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'POSTED',
    },
    totalAmountPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'purchase_returns',
  }
);

PurchaseReturn.belongsTo(Party, { as: 'vendor', foreignKey: 'vendorPartyId' });

module.exports = { PurchaseReturn };
