'use strict';

/**
 * Digital Personal Data Protection Act, 2023 and the DPDP Rules, 2025.
 *
 * The people whose personal data the ERP holds — staff (employees), labour and
 * contractors (parties), individual customers, and the people behind CRM
 * enquiries (leads) — have rights under the Act the system had no way to
 * honour or evidence. These tables are that evidence.
 *
 * The privacy desk belongs to the application owner, not to the organisations
 * using it: one notice and one contact for the whole platform, one breach
 * register and one retention schedule, run by the accounts named in
 * PLATFORM_OWNER_EMAILS. So those four tables carry no tenantId. The records
 * about a particular person (consent, acknowledgement, nominee) stay with the
 * organisation that holds that person's record; a request may arrive before
 * anyone knows which organisation it concerns, so its tenantId is nullable.
 *
 *
 *   privacy_profiles         who answers for personal data (s.8(9), Rule 9)
 *   privacy_notices          the itemised notice, versioned (s.5, Rule 3)
 *   notice_acknowledgements  which staff member saw which version
 *   consent_records          consent given and withdrawn, per purpose (s.6)
 *   data_principal_requests  access / correction / erasure / grievance /
 *                            nomination requests and their outcome (s.11-14)
 *   privacy_nominees         who may act if the person dies or is incapacitated (s.14)
 *   data_breaches            the breach register and the 72-hour report (s.8(6), Rule 7)
 *   retention_rules          when data whose purpose is spent gets erased (s.8(7), Rule 8)
 *
 * `erasedAt` on leads, parties and employees marks a record whose personal
 * fields were wiped. The row itself stays: invoices, wage registers and the
 * audit trail are records the law requires the business to keep, and s.8(7)
 * exempts retention "necessary for compliance with any law".
 */

const ENUM_TYPES = [
  'enum_privacy_notices_status',
  'enum_consent_records_principalType',
  'enum_consent_records_status',
  'enum_consent_records_method',
  'enum_data_principal_requests_type',
  'enum_data_principal_requests_channel',
  'enum_data_principal_requests_principalType',
  'enum_data_principal_requests_requesterRelation',
  'enum_data_principal_requests_status',
  'enum_privacy_nominees_principalType',
  'enum_data_breaches_status',
  'enum_data_breaches_severity',
];

const PRINCIPAL_TYPES = ['USER', 'PARTY', 'LEAD', 'OTHER'];

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    const tenantRef = { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' };
    const employeeRef = (allowNull = true) => ({
      type: Sequelize.UUID, allowNull, references: { model: 'employees', key: 'id' }, onDelete: allowNull ? 'SET NULL' : 'CASCADE',
    });
    const timestamps = {
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    };

    if (!tables.includes('privacy_profiles')) {
      await queryInterface.createTable('privacy_profiles', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        // The person who can answer questions about processing (Rule 9). Not
        // necessarily a statutory DPO — only a Significant Data Fiduciary must
        // appoint one — but someone has to be named.
        contactName: { type: Sequelize.STRING(120), allowNull: true },
        contactDesignation: { type: Sequelize.STRING(120), allowNull: true },
        contactEmail: { type: Sequelize.STRING(160), allowNull: true },
        contactPhone: { type: Sequelize.STRING(20), allowNull: true },
        postalAddress: { type: Sequelize.TEXT, allowNull: true },
        // Rule 14(3) caps grievance redressal at 90 days; a business may promise less.
        responseDays: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 30 },
        // Shown on the public page so a principal can be told where data lives (s.16).
        dataLocation: { type: Sequelize.STRING(200), allowNull: true },
        isSignificantDataFiduciary: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        updatedBy: { type: Sequelize.UUID, allowNull: true },
        ...timestamps,
      });
    }

    if (!tables.includes('privacy_notices')) {
      await queryInterface.createTable('privacy_notices', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        version: { type: Sequelize.INTEGER, allowNull: false },
        status: { type: Sequelize.ENUM('DRAFT', 'PUBLISHED', 'ARCHIVED'), allowNull: false, defaultValue: 'DRAFT' },
        title: { type: Sequelize.STRING(200), allowNull: false },
        // English or any Eighth Schedule language (s.5(3)).
        language: { type: Sequelize.STRING(40), allowNull: false, defaultValue: 'English' },
        summary: { type: Sequelize.TEXT, allowNull: true },
        body: { type: Sequelize.TEXT, allowNull: true },
        // Itemised purposes: [{ code, label, description, dataItems[], principalTypes[],
        //   lawfulBasis: CONSENT | LEGITIMATE_USE, legalReference, retention, optional }]
        purposes: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        // Processors the data is shared with: [{ name, purpose, location }]
        processors: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        publishedAt: { type: Sequelize.DATE, allowNull: true },
        publishedBy: { type: Sequelize.UUID, allowNull: true },
        createdBy: { type: Sequelize.UUID, allowNull: true },
        ...timestamps,
      });
      await queryInterface.addIndex('privacy_notices', ['version'], { unique: true, name: 'privacy_notices_version_unique' });
      // Exactly one notice is in force at a time.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS privacy_notices_one_published ON privacy_notices ((true)) WHERE status = 'PUBLISHED'`
      );
    }

    if (!tables.includes('notice_acknowledgements')) {
      await queryInterface.createTable('notice_acknowledgements', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: tenantRef,
        userId: employeeRef(false),
        noticeId: { type: Sequelize.UUID, allowNull: false, references: { model: 'privacy_notices', key: 'id' }, onDelete: 'CASCADE' },
        noticeVersion: { type: Sequelize.INTEGER, allowNull: false },
        acknowledgedAt: { type: Sequelize.DATE, allowNull: false },
        ipAddress: { type: Sequelize.STRING, allowNull: true },
        userAgent: { type: Sequelize.STRING(300), allowNull: true },
        ...timestamps,
      });
      await queryInterface.addIndex('notice_acknowledgements', ['tenantId', 'userId', 'noticeId'], { unique: true, name: 'notice_ack_user_notice_unique' });
    }

    if (!tables.includes('consent_records')) {
      await queryInterface.createTable('consent_records', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: tenantRef,
        principalType: { type: Sequelize.ENUM(...PRINCIPAL_TYPES), allowNull: false },
        // Null for OTHER: someone with no record in the system (a walk-in who
        // signed a paper form, say). Their name and contact identify them.
        principalId: { type: Sequelize.UUID, allowNull: true },
        principalName: { type: Sequelize.STRING(160), allowNull: true },
        principalContact: { type: Sequelize.STRING(160), allowNull: true },
        purposeCode: { type: Sequelize.STRING(60), allowNull: false },
        noticeId: { type: Sequelize.UUID, allowNull: true, references: { model: 'privacy_notices', key: 'id' }, onDelete: 'SET NULL' },
        noticeVersion: { type: Sequelize.INTEGER, allowNull: true },
        status: { type: Sequelize.ENUM('GRANTED', 'WITHDRAWN'), allowNull: false, defaultValue: 'GRANTED' },
        method: { type: Sequelize.ENUM('IN_APP', 'WEB_FORM', 'WRITTEN', 'EMAIL', 'VERBAL_RECORDED'), allowNull: false },
        evidence: { type: Sequelize.TEXT, allowNull: true },
        grantedAt: { type: Sequelize.DATE, allowNull: false },
        withdrawnAt: { type: Sequelize.DATE, allowNull: true },
        withdrawalReason: { type: Sequelize.TEXT, allowNull: true },
        // s.9: a child's data needs verifiable consent from a parent or lawful guardian.
        isMinor: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        guardianName: { type: Sequelize.STRING(160), allowNull: true },
        guardianRelation: { type: Sequelize.STRING(60), allowNull: true },
        guardianVerification: { type: Sequelize.TEXT, allowNull: true },
        capturedBy: { type: Sequelize.UUID, allowNull: true },
        ipAddress: { type: Sequelize.STRING, allowNull: true },
        userAgent: { type: Sequelize.STRING(300), allowNull: true },
        ...timestamps,
      });
      await queryInterface.addIndex('consent_records', ['tenantId', 'principalType', 'principalId'], { name: 'consent_records_principal' });
      await queryInterface.addIndex('consent_records', ['tenantId', 'purposeCode', 'status'], { name: 'consent_records_purpose_status' });
      // One live consent per person per purpose; a re-grant after withdrawal is a new row.
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS consent_records_one_granted ON consent_records ("tenantId", "principalType", "principalId", "purposeCode") WHERE status = 'GRANTED' AND "principalId" IS NOT NULL`
      );
    }

    if (!tables.includes('data_principal_requests')) {
      await queryInterface.createTable('data_principal_requests', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        // Null until the request is matched to an organisation: one from the public
        // form names no organisation, and SET NULL keeps the request if one is deleted.
        tenantId: { type: Sequelize.UUID, allowNull: true, references: { model: 'tenants', key: 'id' }, onDelete: 'SET NULL' },
        // What the requester said about whom they deal with, for matching.
        requesterOrganisation: { type: Sequelize.STRING(160), allowNull: true },
        requestNumber: { type: Sequelize.STRING(40), allowNull: false },
        type: {
          type: Sequelize.ENUM('ACCESS', 'CORRECTION', 'ERASURE', 'NOMINATION', 'GRIEVANCE', 'CONSENT_WITHDRAWAL'),
          allowNull: false,
        },
        channel: { type: Sequelize.ENUM('IN_APP', 'PUBLIC_FORM', 'EMAIL', 'WRITTEN', 'PHONE'), allowNull: false },
        principalType: { type: Sequelize.ENUM(...PRINCIPAL_TYPES), allowNull: true },
        principalId: { type: Sequelize.UUID, allowNull: true },
        requesterName: { type: Sequelize.STRING(160), allowNull: false },
        requesterEmail: { type: Sequelize.STRING(160), allowNull: true },
        requesterPhone: { type: Sequelize.STRING(20), allowNull: true },
        requesterRelation: { type: Sequelize.ENUM('SELF', 'NOMINEE', 'GUARDIAN', 'AUTHORISED'), allowNull: false, defaultValue: 'SELF' },
        details: { type: Sequelize.TEXT, allowNull: true },
        status: {
          type: Sequelize.ENUM('RECEIVED', 'VERIFYING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED'),
          allowNull: false,
          defaultValue: 'RECEIVED',
        },
        receivedAt: { type: Sequelize.DATE, allowNull: false },
        dueDate: { type: Sequelize.DATEONLY, allowNull: false },
        identityVerifiedAt: { type: Sequelize.DATE, allowNull: true },
        identityVerifiedBy: { type: Sequelize.UUID, allowNull: true },
        verificationNote: { type: Sequelize.TEXT, allowNull: true },
        assignedTo: employeeRef(),
        resolution: { type: Sequelize.TEXT, allowNull: true },
        // What an erasure actually did, field by field, so it can be shown later.
        outcome: { type: Sequelize.JSONB, allowNull: true },
        completedAt: { type: Sequelize.DATE, allowNull: true },
        completedBy: { type: Sequelize.UUID, allowNull: true },
        submittedByUserId: { type: Sequelize.UUID, allowNull: true },
        createdBy: { type: Sequelize.UUID, allowNull: true },
        ...timestamps,
      });
      await queryInterface.addIndex('data_principal_requests', ['requestNumber'], { unique: true, name: 'dpr_number_unique' });
      await queryInterface.addIndex('data_principal_requests', ['status', 'dueDate'], { name: 'dpr_status_due' });
      await queryInterface.addIndex('data_principal_requests', ['tenantId', 'principalType', 'principalId'], { name: 'dpr_principal' });
    }

    if (!tables.includes('privacy_nominees')) {
      await queryInterface.createTable('privacy_nominees', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: tenantRef,
        principalType: { type: Sequelize.ENUM(...PRINCIPAL_TYPES), allowNull: false },
        principalId: { type: Sequelize.UUID, allowNull: false },
        nomineeName: { type: Sequelize.STRING(160), allowNull: false },
        relationship: { type: Sequelize.STRING(60), allowNull: true },
        nomineeEmail: { type: Sequelize.STRING(160), allowNull: true },
        nomineePhone: { type: Sequelize.STRING(20), allowNull: true },
        revokedAt: { type: Sequelize.DATE, allowNull: true },
        createdBy: { type: Sequelize.UUID, allowNull: true },
        ...timestamps,
      });
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS privacy_nominees_one_active ON privacy_nominees ("tenantId", "principalType", "principalId") WHERE "revokedAt" IS NULL`
      );
    }

    if (!tables.includes('data_breaches')) {
      await queryInterface.createTable('data_breaches', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        breachNumber: { type: Sequelize.STRING(40), allowNull: false },
        title: { type: Sequelize.STRING(200), allowNull: false },
        description: { type: Sequelize.TEXT, allowNull: false },
        status: { type: Sequelize.ENUM('OPEN', 'CONTAINED', 'CLOSED'), allowNull: false, defaultValue: 'OPEN' },
        severity: { type: Sequelize.ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'), allowNull: false, defaultValue: 'MEDIUM' },
        occurredAt: { type: Sequelize.DATE, allowNull: true },
        discoveredAt: { type: Sequelize.DATE, allowNull: false },
        containedAt: { type: Sequelize.DATE, allowNull: true },
        cause: { type: Sequelize.TEXT, allowNull: true },
        dataCategories: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        principalCategories: { type: Sequelize.JSONB, allowNull: false, defaultValue: [] },
        affectedCount: { type: Sequelize.INTEGER, allowNull: true },
        likelyConsequences: { type: Sequelize.TEXT, allowNull: true },
        mitigation: { type: Sequelize.TEXT, allowNull: true },
        // What an affected person can do to protect themselves (Rule 7(1)(d)).
        safetyMeasures: { type: Sequelize.TEXT, allowNull: true },
        // Rule 7(2)(a): intimation to the Board without delay.
        boardIntimatedAt: { type: Sequelize.DATE, allowNull: true },
        // Rule 7(2)(b): the detailed report within 72 hours of becoming aware.
        boardReportDueAt: { type: Sequelize.DATE, allowNull: false },
        boardReportSubmittedAt: { type: Sequelize.DATE, allowNull: true },
        boardReference: { type: Sequelize.STRING(120), allowNull: true },
        principalsNotifiedAt: { type: Sequelize.DATE, allowNull: true },
        notificationMethod: { type: Sequelize.STRING(200), allowNull: true },
        closedAt: { type: Sequelize.DATE, allowNull: true },
        reportedBy: { type: Sequelize.UUID, allowNull: true },
        ...timestamps,
      });
      await queryInterface.addIndex('data_breaches', ['breachNumber'], { unique: true, name: 'data_breaches_number_unique' });
    }

    if (!tables.includes('retention_rules')) {
      await queryInterface.createTable('retention_rules', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        category: { type: Sequelize.STRING(60), allowNull: false },
        retentionDays: { type: Sequelize.INTEGER, allowNull: false },
        // Off until the application owner turns it on: erasure cannot be undone.
        // One schedule for the platform, applied to every organisation nightly.
        enabled: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        lastRunAt: { type: Sequelize.DATE, allowNull: true },
        lastRunCount: { type: Sequelize.INTEGER, allowNull: true },
        updatedBy: { type: Sequelize.UUID, allowNull: true },
        ...timestamps,
      });
      await queryInterface.addIndex('retention_rules', ['category'], { unique: true, name: 'retention_rules_category_unique' });
    }

    for (const table of ['leads', 'parties', 'employees']) {
      const columns = await queryInterface.describeTable(table);
      if (!columns.erasedAt) {
        await queryInterface.addColumn(table, 'erasedAt', { type: Sequelize.DATE, allowNull: true });
      }
    }
  },

  async down(queryInterface) {
    for (const table of ['leads', 'parties', 'employees']) {
      await queryInterface.removeColumn(table, 'erasedAt').catch(() => {});
    }
    for (const table of [
      'retention_rules', 'data_breaches', 'privacy_nominees', 'data_principal_requests',
      'consent_records', 'notice_acknowledgements', 'privacy_notices', 'privacy_profiles',
    ]) {
      await queryInterface.dropTable(table).catch(() => {});
    }
    for (const type of ENUM_TYPES) {
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${type}"`);
    }
  },
};
