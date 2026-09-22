const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');

/** A shift at a till. See the migration for what each count means. */
class CashRegisterSession extends BaseAuditedModel {}

CashRegisterSession.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    factoryId: { type: DataTypes.UUID, allowNull: false },
    accountId: { type: DataTypes.UUID, allowNull: true },
    sessionNumber: { type: DataTypes.STRING, allowNull: false },
    status: { type: DataTypes.ENUM('OPEN', 'CLOSED'), allowNull: false, defaultValue: 'OPEN' },

    openedAt: { type: DataTypes.DATE, allowNull: false },
    openedBy: { type: DataTypes.UUID, allowNull: true },
    openingDenominations: { type: DataTypes.JSONB, allowNull: true },
    openingCountedPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    openingExpectedPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    openingVariancePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },

    closedAt: { type: DataTypes.DATE, allowNull: true },
    closedBy: { type: DataTypes.UUID, allowNull: true },
    closingDenominations: { type: DataTypes.JSONB, allowNull: true },
    closingCountedPaise: { type: DataTypes.BIGINT, allowNull: true },
    closingExpectedPaise: { type: DataTypes.BIGINT, allowNull: true },
    closingVariancePaise: { type: DataTypes.BIGINT, allowNull: true },
    varianceAdjusted: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    openingNote: { type: DataTypes.TEXT, allowNull: true },
    closingNote: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, tableName: 'cash_register_sessions' }
);

module.exports = { CashRegisterSession };
