const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');
const { SalesInvoice } = require('../invoicing/salesInvoice.model');

/**
 * M22: physical goods coming back from a customer. Creates a new stock lot
 * (BR-01/BR-02 — a return is a movement like any other, gets its own lot and
 * ledger entry) and reduces the customer's AR via a Sales Return contra-revenue
 * posting (BR-18).
 */
class SalesReturn extends BaseAuditedModel {}

SalesReturn.initAudited(
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
    salesInvoiceId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    customerPartyId: {
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
    tableName: 'sales_returns',
  }
);

SalesReturn.belongsTo(Party, { as: 'customer', foreignKey: 'customerPartyId' });
SalesReturn.belongsTo(SalesInvoice, { as: 'salesInvoice', foreignKey: 'salesInvoiceId' });

module.exports = { SalesReturn };
