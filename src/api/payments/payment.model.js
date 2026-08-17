const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/** M24: money paid out to a vendor/contractor/labour. Mirrors Receipt. */
class Payment extends BaseAuditedModel {}

Payment.initAudited(
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
    paymentNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    partyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    paymentDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    modes: {
      type: DataTypes.JSONB,
      allowNull: false,
    },
    totalAmountPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    unallocatedAmountPaise: {
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
    tableName: 'payments',
  }
);

Payment.belongsTo(Party, { as: 'party', foreignKey: 'partyId' });

module.exports = { Payment };
