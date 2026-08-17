const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/**
 * FR-M18-7: a cheque tracked through its life, ISSUED -> PRESENTED ->
 * CLEARED | BOUNCED.
 *
 * A cheque is not cash. The receipt that accepted it posts to the ledger
 * immediately (the customer's dues are settled on the strength of the cheque),
 * but the money is not actually in the bank until it clears — and if it
 * bounces, that receipt has to be reversed and bank charges recognised. Without
 * this record there is nothing to hang that reversal on.
 *
 * `direction` distinguishes cheques we received (INBOUND, attached to a
 * Receipt) from cheques we issued (OUTBOUND, attached to a Payment).
 */
class Cheque extends BaseAuditedModel {}

Cheque.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    factoryId: { type: DataTypes.UUID, allowNull: false },
    direction: { type: DataTypes.ENUM('INBOUND', 'OUTBOUND'), allowNull: false },
    partyId: { type: DataTypes.UUID, allowNull: false },

    chequeNumber: { type: DataTypes.STRING, allowNull: false },
    bankName: { type: DataTypes.STRING, allowNull: true },
    chequeDate: { type: DataTypes.DATEONLY, allowNull: false },
    amountPaise: { type: DataTypes.BIGINT, allowNull: false },

    status: {
      type: DataTypes.ENUM('ISSUED', 'PRESENTED', 'CLEARED', 'BOUNCED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'ISSUED',
    },
    presentedAt: { type: DataTypes.DATE, allowNull: true },
    clearedAt: { type: DataTypes.DATE, allowNull: true },
    bouncedAt: { type: DataTypes.DATE, allowNull: true },
    bounceReason: { type: DataTypes.TEXT, allowNull: true },
    bankChargesPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },

    // Whichever document created it — exactly one is set.
    receiptId: { type: DataTypes.UUID, allowNull: true },
    paymentId: { type: DataTypes.UUID, allowNull: true },
  },
  {
    sequelize,
    version: 'lockVersion',
    tableName: 'cheques',
  }
);

Cheque.belongsTo(Party, { as: 'party', foreignKey: 'partyId' });

module.exports = { Cheque };
