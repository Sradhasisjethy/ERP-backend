const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/**
 * Chart of accounts (M30). A small fixed set of system accounts is
 * lazily created per tenant by ledgerAccounts.js (getOrCreateSystemAccount) —
 * there's no separate "set up your chart of accounts" step, mirroring how
 * DocumentSeries rows self-create on first use.
 */
class Account extends BaseScopedModel {}

Account.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    type: {
      type: DataTypes.ENUM('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'),
      allowNull: false,
    },
    isPartyControlAccount: {
      // True for Accounts Receivable / Accounts Payable — journal lines
      // against these must carry a partyId so per-party statements/ageing work.
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    // Statement placement (accountGroups.js). NULL on system accounts created
    // before the column existed; accountView() fills it from systemAccounts.js.
    accountGroup: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    // 'BANK' or 'CASH' — an account money can be received into or paid from.
    subType: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    isActive: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    bankName: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
    accountNumber: {
      type: DataTypes.STRING(40),
      allowNull: true,
    },
    ifsc: {
      type: DataTypes.STRING(11),
      allowNull: true,
    },
    branch: {
      type: DataTypes.STRING(120),
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'accounts',
  }
);

module.exports = { Account };
