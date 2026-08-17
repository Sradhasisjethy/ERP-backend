const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/** M28: factory-level operating expenses (fuel, repairs, site supplies, etc.). */
class Expense extends BaseAuditedModel {}

Expense.initAudited(
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
    expenseNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    expenseDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    category: {
      type: DataTypes.STRING,
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
    paidToPartyId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    description: {
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
    tableName: 'expenses',
  }
);

Expense.belongsTo(Party, { as: 'paidToParty', foreignKey: 'paidToPartyId' });

module.exports = { Expense };
