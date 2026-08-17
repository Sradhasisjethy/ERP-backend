const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/**
 * BR-25: advances paid to contractors and labour are adjusted against their
 * dues automatically, oldest-first. In practice this falls out of the ledger
 * for free — an advance debits the party's AP control account exactly like a
 * payment would, so their running balance (LedgerService.getPartyOutstanding)
 * already nets everything chronologically without a separate matching engine.
 */
class Advance extends BaseAuditedModel {}

Advance.initAudited(
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
    advanceNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    partyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    advanceDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    mode: {
      type: DataTypes.ENUM('CASH', 'BANK'),
      allowNull: false,
    },
    amountPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    reason: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('POSTED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'POSTED',
    },
  },
  {
    sequelize,
    tableName: 'advances',
  }
);

Advance.belongsTo(Party, { as: 'party', foreignKey: 'partyId' });

module.exports = { Advance };
