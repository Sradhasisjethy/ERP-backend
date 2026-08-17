const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');
const { SalesInvoice } = require('../invoicing/salesInvoice.model');

/**
 * M23: a non-stock financial adjustment reducing a customer's dues (rate
 * correction, agreed discount, damage claim settled financially). Distinct
 * from SalesReturn (M22), which moves physical stock — this never does.
 */
class CreditNote extends BaseAuditedModel {}

CreditNote.initAudited(
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
    noteNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    customerPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    salesInvoiceId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    noteDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    amountPaise: {
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
    tableName: 'credit_notes',
  }
);

CreditNote.belongsTo(Party, { as: 'customer', foreignKey: 'customerPartyId' });
CreditNote.belongsTo(SalesInvoice, { as: 'salesInvoice', foreignKey: 'salesInvoiceId' });

module.exports = { CreditNote };
