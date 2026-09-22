const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { User } = require('../users/user.model');
const { Party } = require('../parties/party.model');

/** An enquiry that might become a customer. */
class Lead extends BaseAuditedModel {}

Lead.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    leadNumber: { type: DataTypes.STRING, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    contactName: { type: DataTypes.STRING(120), allowNull: true },
    phone: { type: DataTypes.STRING(20), allowNull: true },
    email: { type: DataTypes.STRING(160), allowNull: true },
    city: { type: DataTypes.STRING(80), allowNull: true },
    state: { type: DataTypes.STRING(60), allowNull: true },
    source: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'OTHER' },
    status: { type: DataTypes.ENUM('NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'WON', 'LOST'), allowNull: false, defaultValue: 'NEW' },
    estimatedValuePaise: { type: DataTypes.BIGINT, allowNull: true },
    expectedCloseDate: { type: DataTypes.DATEONLY, allowNull: true },
    ownerId: { type: DataTypes.UUID, allowNull: true },
    requirement: { type: DataTypes.TEXT, allowNull: true },
    lostReason: { type: DataTypes.TEXT, allowNull: true },
    customerPartyId: { type: DataTypes.UUID, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'leads' }
);

/** A call, meeting, note or task against a lead. */
class LeadActivity extends BaseAuditedModel {}

LeadActivity.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    leadId: { type: DataTypes.UUID, allowNull: false },
    type: { type: DataTypes.ENUM('NOTE', 'CALL', 'MEETING', 'EMAIL', 'SITE_VISIT', 'TASK'), allowNull: false },
    subject: { type: DataTypes.STRING(200), allowNull: false },
    detail: { type: DataTypes.TEXT, allowNull: true },
    occurredAt: { type: DataTypes.DATE, allowNull: true },
    dueDate: { type: DataTypes.DATEONLY, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    assignedTo: { type: DataTypes.UUID, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'lead_activities' }
);

Lead.hasMany(LeadActivity, { as: 'activities', foreignKey: 'leadId' });
LeadActivity.belongsTo(Lead, { as: 'lead', foreignKey: 'leadId' });
Lead.belongsTo(User, { as: 'owner', foreignKey: 'ownerId' });
Lead.belongsTo(Party, { as: 'customer', foreignKey: 'customerPartyId' });
LeadActivity.belongsTo(User, { as: 'assignee', foreignKey: 'assignedTo' });

module.exports = { Lead, LeadActivity };
