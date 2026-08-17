const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/**
 * M24: money received from a customer. BR-19: may be split across modes in
 * one transaction (`modes` JSONB), and the sum of modes must equal
 * totalAmountPaise. BR-20: allocation to specific invoices (M25) is optional
 * at receipt time — whatever isn't allocated sits as on-account credit,
 * visible via unallocatedAmountPaise rather than being forced onto an invoice.
 */
class Receipt extends BaseAuditedModel {}

Receipt.initAudited(
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
    receiptNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    customerPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    receiptDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    modes: {
      // [{ mode: 'CASH'|'UPI'|'BANK'|'CHEQUE', amountPaise }]
      type: DataTypes.JSONB,
      allowNull: false,
    },
    totalAmountPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    unallocatedAmountPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('POSTED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'POSTED',
    },
  },
  {
    sequelize,
    tableName: 'receipts',
  }
);

Receipt.belongsTo(Party, { as: 'customer', foreignKey: 'customerPartyId' });

module.exports = { Receipt };
