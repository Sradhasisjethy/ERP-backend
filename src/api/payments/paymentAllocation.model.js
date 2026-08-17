const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Receipt } = require('./receipt.model');
const { Payment } = require('./payment.model');

/**
 * M25: bill-wise adjustment — which invoice(s) a receipt/payment counts
 * against. Purely a tracking record; it does not itself post to the ledger
 * (the receipt/payment already posted the AR/AP movement — this just says
 * how much of it maps to which bill, per BR-20).
 */
class PaymentAllocation extends BaseAuditedModel {}

PaymentAllocation.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    receiptId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    paymentId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    invoiceType: {
      type: DataTypes.ENUM('SALES', 'PURCHASE'),
      allowNull: false,
    },
    invoiceId: {
      // Polymorphic: SalesInvoice.id or PurchaseInvoice.id depending on invoiceType.
      type: DataTypes.UUID,
      allowNull: false,
    },
    allocatedAmountPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'payment_allocations',
  }
);

PaymentAllocation.belongsTo(Receipt, { as: 'receipt', foreignKey: 'receiptId' });
PaymentAllocation.belongsTo(Payment, { as: 'payment', foreignKey: 'paymentId' });
Receipt.hasMany(PaymentAllocation, { as: 'allocations', foreignKey: 'receiptId' });
Payment.hasMany(PaymentAllocation, { as: 'allocations', foreignKey: 'paymentId' });

module.exports = { PaymentAllocation };
