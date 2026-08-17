const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');
const { JournalEntry } = require('./journalEntry.model');
const { Account } = require('./account.model');

class JournalLine extends BaseScopedModel {}

JournalLine.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    journalEntryId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    accountId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    // Required when the account is a party control account (AR/AP) — this is
    // what makes a per-party statement/ageing report possible (BR-13's ageing
    // half, party ledgers, etc.) without a separate sub-ledger table.
    partyId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    debitPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    creditPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'journal_lines',
    updatedAt: false,
  }
);

JournalLine.belongsTo(JournalEntry, { as: 'journalEntry', foreignKey: 'journalEntryId' });
JournalLine.belongsTo(Account, { as: 'account', foreignKey: 'accountId' });
JournalEntry.hasMany(JournalLine, { as: 'lines', foreignKey: 'journalEntryId' });

module.exports = { JournalLine };
