const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { User } = require('../users/user.model');

/** A kind of leave and how much of it a person gets in a year. */
class LeaveType extends BaseAuditedModel {}

LeaveType.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    code: { type: DataTypes.STRING(20), allowNull: false },
    name: { type: DataTypes.STRING(80), allowNull: false },
    daysPerYear: { type: DataTypes.DECIMAL(5, 1), allowNull: false, defaultValue: 0 },
    isPaid: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isActive: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    description: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, tableName: 'leave_types' }
);

/** One application for leave, and what was decided about it. */
class LeaveRequest extends BaseAuditedModel {}

LeaveRequest.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    employeeId: { type: DataTypes.UUID, allowNull: false },
    leaveTypeId: { type: DataTypes.UUID, allowNull: false },
    fromDate: { type: DataTypes.DATEONLY, allowNull: false },
    toDate: { type: DataTypes.DATEONLY, allowNull: false },
    days: { type: DataTypes.DECIMAL(5, 1), allowNull: false },
    reason: { type: DataTypes.TEXT, allowNull: true },
    status: { type: DataTypes.ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'), allowNull: false, defaultValue: 'PENDING' },
    decidedBy: { type: DataTypes.UUID, allowNull: true },
    decidedAt: { type: DataTypes.DATE, allowNull: true },
    decisionNote: { type: DataTypes.TEXT, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'leave_requests' }
);

/** A day of a staff member's attendance. One row per person per day. */
class StaffAttendance extends BaseAuditedModel {}

StaffAttendance.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    employeeId: { type: DataTypes.UUID, allowNull: false },
    factoryId: { type: DataTypes.UUID, allowNull: true },
    attendanceDate: { type: DataTypes.DATEONLY, allowNull: false },
    status: { type: DataTypes.ENUM('PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY'), allowNull: false },
    inTime: { type: DataTypes.STRING(5), allowNull: true },
    outTime: { type: DataTypes.STRING(5), allowNull: true },
    note: { type: DataTypes.TEXT, allowNull: true },
    markedBy: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'staff_attendance' }
);

LeaveRequest.belongsTo(LeaveType, { as: 'leaveType', foreignKey: 'leaveTypeId' });
LeaveRequest.belongsTo(User, { as: 'employee', foreignKey: 'employeeId' });
StaffAttendance.belongsTo(User, { as: 'employee', foreignKey: 'employeeId' });

module.exports = { LeaveType, LeaveRequest, StaffAttendance };
