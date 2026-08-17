const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');
const { GoodsReceipt } = require('./goodsReceipt.model');

/**
 * Lightweight payable record against a GRN — tracks what the vendor billed
 * and whether it's paid. Full GST invoicing (CGST/SGST/IGST breakdown, HSN
 * rounding) is M20 (Phase 2); this is only the M12 "we owe them this much"
 * record needed to run Phase 1 without full statutory billing.
 */
class PurchaseInvoice extends BaseAuditedModel {}

PurchaseInvoice.initAudited(
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
    goodsReceiptId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    vendorPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    vendorInvoiceNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    invoiceDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    dueDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    amountPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    paymentStatus: {
      type: DataTypes.ENUM('UNPAID', 'PARTIALLY_PAID', 'PAID'),
      allowNull: false,
      defaultValue: 'UNPAID',
    },
  },
  {
    sequelize,
    tableName: 'purchase_invoices',
  }
);

PurchaseInvoice.belongsTo(Party, { as: 'vendor', foreignKey: 'vendorPartyId' });
PurchaseInvoice.belongsTo(GoodsReceipt, { as: 'goodsReceipt', foreignKey: 'goodsReceiptId' });

module.exports = { PurchaseInvoice };
