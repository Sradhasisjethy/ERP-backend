const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('./party.model');

/**
 * Wage terms for a partyType=LABOUR party (BR-24: marking a labourer present
 * accrues the applicable wage same-day; half day accrues 50%, overtime at the
 * configured rate). Wage accrual itself is Phase 2 (M27) — this is just the
 * master data it will read from.
 */
class LabourWageProfile extends BaseAuditedModel {}

LabourWageProfile.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    partyId: {
      type: DataTypes.UUID,
      allowNull: false,
      unique: true,
    },
    dailyWagePaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    overtimeRateMultiplier: {
      type: DataTypes.DECIMAL(4, 2),
      allowNull: false,
      defaultValue: 1.5,
    },
    effectiveFrom: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'labour_wage_profiles',
  }
);

LabourWageProfile.belongsTo(Party, { as: 'party', foreignKey: 'partyId' });

module.exports = { LabourWageProfile };
