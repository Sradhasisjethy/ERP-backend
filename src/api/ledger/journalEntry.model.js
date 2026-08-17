const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/**
 * BR-18: every financial transaction posts a balanced double-entry journal —
 * debits must equal credits or the transaction is rejected. Immutable once
 * posted, same as StockLedgerEntry: corrections are a reversing journal
 * (ledger.service.js#reverseJournal), never an edit.
 */
class JournalEntry extends BaseScopedModel {}

JournalEntry.initScoped(
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
    entryDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    referenceType: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    referenceId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    narration: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    totalDebitPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    totalCreditPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    reversalOfEntryId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    createdBy: {
      type: DataTypes.UUID,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'journal_entries',
    updatedAt: false,
  }
);

module.exports = { JournalEntry };
