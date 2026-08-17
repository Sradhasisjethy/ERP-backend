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
  },
  {
    sequelize,
    tableName: 'accounts',
  }
);

module.exports = { Account };
