const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/**
 * M20: GST sales invoice. Created from one or more DISPATCHED, not-yet-invoiced
 * delivery challans (M21) — see invoicing.service.js#createInvoiceFromChallans.
 * BR-15 (a challan converts once and only once) is enforced there, not here.
 */
class SalesInvoice extends BaseAuditedModel {}

SalesInvoice.initAudited(
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
    invoiceNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    customerPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    // FR-M16-2: place of supply is snapshotted on the invoice because it
    // determined the tax heads. A later edit to the customer's address must
    // never retroactively change what a filed invoice claimed.
    placeOfSupplyCode: {
      type: DataTypes.STRING(2),
      allowNull: true,
    },
    supplierStateCode: {
      type: DataTypes.STRING(2),
      allowNull: true,
    },
    shippingAddressId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    invoiceDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('POSTED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'POSTED',
    },
    // Intra-state = CGST+SGST split; inter-state = IGST. One or the other is
    // always zero across the whole invoice (determined once from factory vs
    // customer state — see invoicing.service.js).
    subtotalPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    cgstPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    sgstPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    igstPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    roundOffPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    totalPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    cancelReason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'sales_invoices',
  }
);

SalesInvoice.belongsTo(Party, { as: 'customer', foreignKey: 'customerPartyId' });

module.exports = { SalesInvoice };
