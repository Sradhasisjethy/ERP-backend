const { DataTypes, Model } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { BaseScopedModel } = require('../../core/BaseModel');
const { User } = require('../users/user.model');
const { Tenant } = require('../organization/tenant.model');

/**
 * DPDP Act 2023 / DPDP Rules 2025 records. See
 * migrations/20261014000000-dpdp-privacy.js for why each table exists, and
 * docs/dpdp/ for the section-by-section mapping.
 *
 * The desk belongs to the application owner, so four kinds of record are
 * platform-wide plain models with no tenantId: the contact, the notice, the
 * breach register and the retention schedule. A request is platform-wide too
 * (it may arrive before anyone knows which organisation it concerns) with a
 * nullable tenantId the owner fills in. What is about one person inside one
 * organisation — consent, acknowledgement, nominee — stays tenant-scoped and
 * audited, and the owner's desk writes it inside that organisation's context.
 *
 * Platform models skip the audit hooks (audit_logs is per tenant); each
 * carries who changed it (updatedBy / publishedBy / reportedBy / completedBy).
 */

const PRINCIPAL_TYPES = ['USER', 'PARTY', 'LEAD', 'OTHER'];

/** Who answers for personal data at this business (s.8(9), Rule 9). One row per tenant. */
class PrivacyProfile extends Model {}

PrivacyProfile.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    contactName: { type: DataTypes.STRING(120), allowNull: true },
    contactDesignation: { type: DataTypes.STRING(120), allowNull: true },
    contactEmail: { type: DataTypes.STRING(160), allowNull: true },
    contactPhone: { type: DataTypes.STRING(20), allowNull: true },
    postalAddress: { type: DataTypes.TEXT, allowNull: true },
    responseDays: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 30 },
    dataLocation: { type: DataTypes.STRING(200), allowNull: true },
    isSignificantDataFiduciary: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    updatedBy: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'privacy_profiles' }
);

/** The itemised notice of s.5 / Rule 3, versioned. Only one is PUBLISHED at a time. */
class PrivacyNotice extends Model {}

PrivacyNotice.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    version: { type: DataTypes.INTEGER, allowNull: false },
    status: { type: DataTypes.ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED'), allowNull: false, defaultValue: 'DRAFT' },
    title: { type: DataTypes.STRING(200), allowNull: false },
    language: { type: DataTypes.STRING(40), allowNull: false, defaultValue: 'English' },
    summary: { type: DataTypes.TEXT, allowNull: true },
    body: { type: DataTypes.TEXT, allowNull: true },
    purposes: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    processors: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    publishedAt: { type: DataTypes.DATE, allowNull: true },
    publishedBy: { type: DataTypes.UUID, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'privacy_notices' }
);

/**
 * A staff member saw a given notice version. Not audited through the hooks:
 * the row is itself the evidence, and it is never updated.
 */
class NoticeAcknowledgement extends BaseScopedModel {}

NoticeAcknowledgement.initScoped(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    userId: { type: DataTypes.UUID, allowNull: false },
    noticeId: { type: DataTypes.UUID, allowNull: false },
    noticeVersion: { type: DataTypes.INTEGER, allowNull: false },
    acknowledgedAt: { type: DataTypes.DATE, allowNull: false },
    ipAddress: { type: DataTypes.STRING, allowNull: true },
    userAgent: { type: DataTypes.STRING(300), allowNull: true },
  },
  { sequelize, tableName: 'notice_acknowledgements' }
);

/** Consent for one purpose, from grant to withdrawal (s.6). */
class ConsentRecord extends BaseAuditedModel {}

ConsentRecord.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    principalType: { type: DataTypes.ENUM(...PRINCIPAL_TYPES), allowNull: false },
    principalId: { type: DataTypes.UUID, allowNull: true },
    principalName: { type: DataTypes.STRING(160), allowNull: true },
    principalContact: { type: DataTypes.STRING(160), allowNull: true },
    purposeCode: { type: DataTypes.STRING(60), allowNull: false },
    noticeId: { type: DataTypes.UUID, allowNull: true },
    noticeVersion: { type: DataTypes.INTEGER, allowNull: true },
    status: { type: DataTypes.ENUM('GRANTED', 'WITHDRAWN'), allowNull: false, defaultValue: 'GRANTED' },
    method: { type: DataTypes.ENUM('IN_APP', 'WEB_FORM', 'WRITTEN', 'EMAIL', 'VERBAL_RECORDED'), allowNull: false },
    evidence: { type: DataTypes.TEXT, allowNull: true },
    grantedAt: { type: DataTypes.DATE, allowNull: false },
    withdrawnAt: { type: DataTypes.DATE, allowNull: true },
    withdrawalReason: { type: DataTypes.TEXT, allowNull: true },
    isMinor: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    guardianName: { type: DataTypes.STRING(160), allowNull: true },
    guardianRelation: { type: DataTypes.STRING(60), allowNull: true },
    guardianVerification: { type: DataTypes.TEXT, allowNull: true },
    capturedBy: { type: DataTypes.UUID, allowNull: true },
    ipAddress: { type: DataTypes.STRING, allowNull: true },
    userAgent: { type: DataTypes.STRING(300), allowNull: true },
  },
  { sequelize, tableName: 'consent_records' }
);

/** A request from a Data Principal exercising a right under ss.11-14. */
class DataPrincipalRequest extends Model {}

DataPrincipalRequest.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    tenantId: { type: DataTypes.UUID, allowNull: true },
    requesterOrganisation: { type: DataTypes.STRING(160), allowNull: true },
    requestNumber: { type: DataTypes.STRING(40), allowNull: false },
    type: {
      type: DataTypes.ENUM('ACCESS', 'CORRECTION', 'ERASURE', 'NOMINATION', 'GRIEVANCE', 'CONSENT_WITHDRAWAL'),
      allowNull: false,
    },
    channel: { type: DataTypes.ENUM('IN_APP', 'PUBLIC_FORM', 'EMAIL', 'WRITTEN', 'PHONE'), allowNull: false },
    principalType: { type: DataTypes.ENUM(...PRINCIPAL_TYPES), allowNull: true },
    principalId: { type: DataTypes.UUID, allowNull: true },
    requesterName: { type: DataTypes.STRING(160), allowNull: false },
    requesterEmail: { type: DataTypes.STRING(160), allowNull: true },
    requesterPhone: { type: DataTypes.STRING(20), allowNull: true },
    requesterRelation: { type: DataTypes.ENUM('SELF', 'NOMINEE', 'GUARDIAN', 'AUTHORISED'), allowNull: false, defaultValue: 'SELF' },
    details: { type: DataTypes.TEXT, allowNull: true },
    status: {
      type: DataTypes.ENUM('RECEIVED', 'VERIFYING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED'),
      allowNull: false,
      defaultValue: 'RECEIVED',
    },
    receivedAt: { type: DataTypes.DATE, allowNull: false },
    dueDate: { type: DataTypes.DATEONLY, allowNull: false },
    identityVerifiedAt: { type: DataTypes.DATE, allowNull: true },
    identityVerifiedBy: { type: DataTypes.UUID, allowNull: true },
    verificationNote: { type: DataTypes.TEXT, allowNull: true },
    assignedTo: { type: DataTypes.UUID, allowNull: true },
    resolution: { type: DataTypes.TEXT, allowNull: true },
    outcome: { type: DataTypes.JSONB, allowNull: true },
    completedAt: { type: DataTypes.DATE, allowNull: true },
    completedBy: { type: DataTypes.UUID, allowNull: true },
    submittedByUserId: { type: DataTypes.UUID, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'data_principal_requests' }
);

/** Someone who may exercise a person's rights after their death or incapacity (s.14). */
class PrivacyNominee extends BaseAuditedModel {}

PrivacyNominee.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    principalType: { type: DataTypes.ENUM(...PRINCIPAL_TYPES), allowNull: false },
    principalId: { type: DataTypes.UUID, allowNull: false },
    nomineeName: { type: DataTypes.STRING(160), allowNull: false },
    relationship: { type: DataTypes.STRING(60), allowNull: true },
    nomineeEmail: { type: DataTypes.STRING(160), allowNull: true },
    nomineePhone: { type: DataTypes.STRING(20), allowNull: true },
    revokedAt: { type: DataTypes.DATE, allowNull: true },
    createdBy: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'privacy_nominees' }
);

/** The personal data breach register (s.8(6), Rule 7). */
class DataBreach extends Model {}

DataBreach.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    breachNumber: { type: DataTypes.STRING(40), allowNull: false },
    title: { type: DataTypes.STRING(200), allowNull: false },
    description: { type: DataTypes.TEXT, allowNull: false },
    status: { type: DataTypes.ENUM('OPEN', 'CONTAINED', 'CLOSED'), allowNull: false, defaultValue: 'OPEN' },
    severity: { type: DataTypes.ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'), allowNull: false, defaultValue: 'MEDIUM' },
    occurredAt: { type: DataTypes.DATE, allowNull: true },
    discoveredAt: { type: DataTypes.DATE, allowNull: false },
    containedAt: { type: DataTypes.DATE, allowNull: true },
    cause: { type: DataTypes.TEXT, allowNull: true },
    dataCategories: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    principalCategories: { type: DataTypes.JSONB, allowNull: false, defaultValue: [] },
    affectedCount: { type: DataTypes.INTEGER, allowNull: true },
    likelyConsequences: { type: DataTypes.TEXT, allowNull: true },
    mitigation: { type: DataTypes.TEXT, allowNull: true },
    safetyMeasures: { type: DataTypes.TEXT, allowNull: true },
    boardIntimatedAt: { type: DataTypes.DATE, allowNull: true },
    boardReportDueAt: { type: DataTypes.DATE, allowNull: false },
    boardReportSubmittedAt: { type: DataTypes.DATE, allowNull: true },
    boardReference: { type: DataTypes.STRING(120), allowNull: true },
    principalsNotifiedAt: { type: DataTypes.DATE, allowNull: true },
    notificationMethod: { type: DataTypes.STRING(200), allowNull: true },
    closedAt: { type: DataTypes.DATE, allowNull: true },
    reportedBy: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'data_breaches' }
);

/** How long a category of personal data is kept once its purpose is spent (s.8(7), Rule 8). */
class RetentionRule extends Model {}

RetentionRule.init(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    category: { type: DataTypes.STRING(60), allowNull: false },
    retentionDays: { type: DataTypes.INTEGER, allowNull: false },
    enabled: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    lastRunAt: { type: DataTypes.DATE, allowNull: true },
    lastRunCount: { type: DataTypes.INTEGER, allowNull: true },
    updatedBy: { type: DataTypes.UUID, allowNull: true },
  },
  { sequelize, tableName: 'retention_rules' }
);

DataPrincipalRequest.belongsTo(User, { as: 'assignee', foreignKey: 'assignedTo', constraints: false });
DataPrincipalRequest.belongsTo(Tenant, { as: 'organisation', foreignKey: 'tenantId', constraints: false });
ConsentRecord.belongsTo(Tenant, { as: 'organisation', foreignKey: 'tenantId', constraints: false });
NoticeAcknowledgement.belongsTo(PrivacyNotice, { as: 'notice', foreignKey: 'noticeId', constraints: false });

module.exports = {
  PRINCIPAL_TYPES,
  PrivacyProfile,
  PrivacyNotice,
  NoticeAcknowledgement,
  ConsentRecord,
  DataPrincipalRequest,
  PrivacyNominee,
  DataBreach,
  RetentionRule,
};
