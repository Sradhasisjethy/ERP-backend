const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');

/**
 * A manual voucher: the document behind a journal entry that no other module
 * raises — a loan received, capital introduced, the monthly GST set-off, a
 * provision, a bank-to-bank transfer.
 *
 * The lines themselves are not stored here. They are the journal entry's lines
 * (referenceType 'JournalVoucher'), so there is exactly one copy of what was
 * posted and no way for the voucher and the ledger to disagree.
 *
 * JOURNAL moves value between any non-party accounts. CONTRA is restricted to
 * cash and bank accounts — the voucher type an auditor expects for a deposit,
 * a withdrawal or a transfer between banks.
 */
class JournalVoucher extends BaseAuditedModel {}

JournalVoucher.initAudited(
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
    voucherNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    voucherType: {
      type: DataTypes.ENUM('JOURNAL', 'CONTRA'),
      allowNull: false,
    },
    voucherDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    narration: {
      type: DataTypes.TEXT,
      allowNull: false,
    },
    totalPaise: {
      type: DataTypes.BIGINT,
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
    createdBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'journal_vouchers',
  }
);

module.exports = { JournalVoucher };
