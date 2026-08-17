const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/**
 * BR-24: marking a labourer present accrues the applicable wage to their
 * ledger on the same day — half day accrues 50%, overtime at the configured
 * rate. wageAccruedPaise snapshots the amount actually posted (computed from
 * LabourWageProfile at the time), so a later rate change never rewrites history.
 */
class AttendanceRecord extends BaseAuditedModel {}

AttendanceRecord.initAudited(
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
    labourPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    attendanceDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('PRESENT', 'HALF_DAY', 'ABSENT', 'OVERTIME'),
      allowNull: false,
    },
    overtimeHours: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
    },
    wageAccruedPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
  },
  {
    sequelize,
    tableName: 'attendance_records',
  }
);

AttendanceRecord.belongsTo(Party, { as: 'labour', foreignKey: 'labourPartyId' });

module.exports = { AttendanceRecord };
