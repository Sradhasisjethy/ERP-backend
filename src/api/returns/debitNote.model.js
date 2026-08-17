const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/** M23: a non-stock financial adjustment reducing what we owe a vendor. */
class DebitNote extends BaseAuditedModel {}

DebitNote.initAudited(
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
    vendorPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
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
    tableName: 'debit_notes',
  }
);

DebitNote.belongsTo(Party, { as: 'vendor', foreignKey: 'vendorPartyId' });

module.exports = { DebitNote };
