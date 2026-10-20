const { Op, QueryTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const {
  PrivacyProfile, PrivacyNotice, NoticeAcknowledgement, ConsentRecord, PrivacyNominee,
  DataPrincipalRequest, DataBreach, RetentionRule,
} = require('./privacy.model');
const { STARTER_PURPOSES, STARTER_PROCESSORS, STARTER_SUMMARY, MAX_RESPONSE_DAYS } = require('./privacy.constants');
const { User } = require('../users/user.model');
const { Party } = require('../parties/party.model');
const { Lead } = require('../crm/lead.model');
const { AuditLog } = require('../audit/auditLog.model');
const { NotFoundError, ValidationError, ConflictError } = require('../../core/AppError');
const { getUserId, getTenantId } = require('../../core/tenantContext');
const { asTenant } = require('../../core/platformOwner');
const { Tenant } = require('../organization/tenant.model');
const { searchWhere } = require('../../utils/pagination');
const { env } = require('../../config/env');
const { isoDateInZone } = require('../../utils/dateDisplay');

const PRINCIPAL_MODELS = { USER: User, PARTY: Party, LEAD: Lead };

const today = () => isoDateInZone(new Date(), env.APP_TIMEZONE);

/** Age in whole years on `onDate` (YYYY-MM-DD), or null without a date of birth. */
const ageOn = (dateOfBirth, onDate = today()) => {
  if (!dateOfBirth) return null;
  const [y, m, d] = String(dateOfBirth).slice(0, 10).split('-').map(Number);
  const [ty, tm, td] = onDate.split('-').map(Number);
  return ty - y - (tm < m || (tm === m && td < d) ? 1 : 0);
};

/** Display name and a contact for a principal, for consent and request rows. */
const describePrincipal = async (principalType, principalId, transaction) => {
  const Model = PRINCIPAL_MODELS[principalType];
  if (!Model || !principalId) return null;
  const row = await Model.findByPk(principalId, { transaction });
  if (!row) throw new NotFoundError(`${principalType.toLowerCase()} not found`);
  if (principalType === 'USER') {
    return { name: [row.firstName, row.lastName].filter(Boolean).join(' '), contact: row.email };
  }
  if (principalType === 'LEAD') return { name: row.contactName || row.name, contact: row.phone || row.email };
  return { name: row.name, contact: row.phone || row.email };
};

class PrivacyService {
  // ---------------------------------------------------------------- profile

  static async getProfile(transaction) {
    const profile = await PrivacyProfile.findOne({ transaction });
    return profile || { responseDays: 30, isSignificantDataFiduciary: false };
  }

  static async updateProfile(input) {
    if (input.responseDays !== undefined && (input.responseDays < 1 || input.responseDays > MAX_RESPONSE_DAYS)) {
      throw new ValidationError(`Response time must be between 1 and ${MAX_RESPONSE_DAYS} days (DPDP Rules r.14(3))`);
    }
    return sequelize.transaction(async (transaction) => {
      const existing = await PrivacyProfile.findOne({ transaction, lock: transaction.LOCK.UPDATE });
      const values = { ...input, updatedBy: getUserId() || null };
      if (existing) return existing.update(values, { transaction });
      return PrivacyProfile.create(values, { transaction });
    });
  }

  // ---------------------------------------------------------------- notices

  static async listNotices() {
    return PrivacyNotice.findAll({ order: [['version', 'DESC']] });
  }

  static async getPublishedNotice(transaction) {
    return PrivacyNotice.findOne({ where: { status: 'PUBLISHED' }, transaction });
  }

  static async getNotice(id) {
    const notice = await PrivacyNotice.findByPk(id);
    if (!notice) throw new NotFoundError('Notice not found');
    return notice;
  }

  /**
   * A new draft. With no content it starts from the current notice, or from
   * the starter template the first time, so nobody writes one from blank.
   */
  static async createNotice(input = {}) {
    return sequelize.transaction(async (transaction) => {
      const max = await PrivacyNotice.max('version', { transaction });
      const base = input.title ? null : (await this.getPublishedNotice(transaction));
      const notice = await PrivacyNotice.create(
        {
          version: (Number(max) || 0) + 1,
          status: 'DRAFT',
          title: input.title || base?.title || 'Privacy notice',
          language: input.language || base?.language || 'English',
          summary: input.summary ?? base?.summary ?? STARTER_SUMMARY,
          body: input.body ?? base?.body ?? null,
          purposes: input.purposes || base?.purposes || STARTER_PURPOSES,
          processors: input.processors || base?.processors || STARTER_PROCESSORS,
          createdBy: getUserId() || null,
        },
        { transaction }
      );
      return notice;
    });
  }

  static async updateNotice(id, input) {
    const notice = await this.getNotice(id);
    // A published notice is what people were shown; changing it would rewrite
    // what they agreed to. Edits go into a new version.
    if (notice.status !== 'DRAFT') throw new ValidationError('Only a draft notice can be edited. Create a new version instead.');
    return notice.update(input);
  }

  static async publishNotice(id) {
    return sequelize.transaction(async (transaction) => {
      const notice = await PrivacyNotice.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!notice) throw new NotFoundError('Notice not found');
      if (notice.status !== 'DRAFT') throw new ValidationError('Only a draft notice can be published');
      if (!Array.isArray(notice.purposes) || !notice.purposes.length) {
        throw new ValidationError('A notice must list at least one purpose (DPDP s.5(1)(i))');
      }
      const profile = await PrivacyProfile.findOne({ transaction });
      if (!profile || !profile.contactEmail) {
        throw new ValidationError('Name the privacy contact and their email before publishing (DPDP s.8(9), Rules r.9)');
      }
      const current = await PrivacyNotice.findOne({ where: { status: 'PUBLISHED' }, transaction, lock: transaction.LOCK.UPDATE });
      if (current) await current.update({ status: 'ARCHIVED' }, { transaction });
      return notice.update({ status: 'PUBLISHED', publishedAt: new Date(), publishedBy: getUserId() || null }, { transaction });
    });
  }

  static async deleteNotice(id) {
    const notice = await this.getNotice(id);
    if (notice.status !== 'DRAFT') throw new ValidationError('Only a draft notice can be deleted');
    await notice.destroy();
    return true;
  }

  // ------------------------------------------------------- acknowledgements

  static async acknowledge(userId, { ip, userAgent } = {}) {
    const notice = await this.getPublishedNotice();
    if (!notice) throw new ValidationError('There is no published privacy notice to acknowledge');
    const existing = await NoticeAcknowledgement.findOne({ where: { userId, noticeId: notice.id } });
    if (existing) return existing;
    return NoticeAcknowledgement.create({
      userId,
      noticeId: notice.id,
      noticeVersion: notice.version,
      acknowledgedAt: new Date(),
      ipAddress: ip || null,
      userAgent: userAgent ? String(userAgent).slice(0, 300) : null,
    });
  }

  static async acknowledgementCoverage(noticeId) {
    const activeUsers = await User.count({ where: { status: { [Op.notIn]: ['INACTIVE', 'TERMINATED'] }, isSystem: { [Op.not]: true } } });
    const acknowledged = noticeId ? await NoticeAcknowledgement.count({ where: { noticeId } }) : 0;
    return { activeUsers, acknowledged };
  }

  // --------------------------------------------------------------- consents

  /** Across every organisation on the owner's desk; within one on My privacy. */
  static async listConsents(page, limit, { tenantId, principalType, principalId, purposeCode, status, search } = {}) {
    const where = {};
    if (tenantId) where.tenantId = tenantId;
    if (principalType) where.principalType = principalType;
    if (principalId) where.principalId = principalId;
    if (purposeCode) where.purposeCode = purposeCode;
    if (status) where.status = status;
    if (search) Object.assign(where, searchWhere(search, ['principalName', 'principalContact', 'purposeCode']));
    const { rows, count } = await ConsentRecord.findAndCountAll({
      where, limit, offset: (page - 1) * limit, order: [['grantedAt', 'DESC']],
      include: [{ model: Tenant, as: 'organisation', attributes: ['id', 'name'] }],
    });
    return {
      rows: rows.map((r) => {
        const { organisation, ...json } = r.toJSON();
        return { ...json, tenantId: organisation?.id || null, organisationName: organisation?.name || null };
      }),
      count,
    };
  }

  static async consentsFor(principalType, principalId) {
    return ConsentRecord.findAll({ where: { principalType, principalId }, order: [['grantedAt', 'DESC']] });
  }

  /**
   * Records consent for one purpose. The purpose must be one the published
   * notice lists as consent-based: consent to something nobody was told about
   * is not "informed" (s.6(1)), and a legitimate-use purpose needs none.
   */
  static async recordConsent(input, client = {}) {
    // From the owner's desk there is no organisation in context: the consent is
    // recorded as the organisation that holds the person's record.
    if (!getTenantId()) {
      if (!input.tenantId) throw new ValidationError('Choose the organisation this person belongs to');
      const exists = await Tenant.findByPk(input.tenantId, { attributes: ['id'] });
      if (!exists) throw new NotFoundError('Organisation not found');
      return asTenant(input.tenantId, () => this.recordConsent(input, client));
    }
    const { ip, userAgent } = client;
    return sequelize.transaction(async (transaction) => {
      const notice = await this.getPublishedNotice(transaction);
      if (!notice) throw new ValidationError('Publish a privacy notice before recording consent (DPDP s.5)');
      const purpose = (notice.purposes || []).find((p) => p.code === input.purposeCode);
      if (!purpose) throw new ValidationError(`The published notice has no purpose "${input.purposeCode}"`);
      if (purpose.lawfulBasis !== 'CONSENT') {
        throw new ValidationError(`"${purpose.label}" relies on a legitimate use (s.7), not consent`);
      }

      const described = input.principalId ? await describePrincipal(input.principalType, input.principalId, transaction) : null;
      if (!described && !input.principalName) throw new ValidationError('Name the person giving consent');

      // s.9: a child's consent is the guardian's, verifiably.
      if (input.principalType === 'PARTY' && input.principalId) {
        const party = await Party.scope('withSensitive').findByPk(input.principalId, { attributes: ['id', 'dateOfBirth'], transaction });
        const age = ageOn(party?.dateOfBirth);
        if (age !== null && age < 18) input.isMinor = true;
      }
      if (input.isMinor && !(input.guardianName && input.guardianVerification)) {
        throw new ValidationError('This person is under 18: record the parent or guardian and how they were verified (DPDP s.9)');
      }

      if (input.principalId) {
        const live = await ConsentRecord.findOne({
          where: { principalType: input.principalType, principalId: input.principalId, purposeCode: input.purposeCode, status: 'GRANTED' },
          transaction,
        });
        if (live) throw new ConflictError('Consent for this purpose is already on record');
      }

      return ConsentRecord.create(
        {
          principalType: input.principalType,
          principalId: input.principalId || null,
          principalName: input.principalName || described?.name || null,
          principalContact: input.principalContact || described?.contact || null,
          purposeCode: input.purposeCode,
          noticeId: notice.id,
          noticeVersion: notice.version,
          status: 'GRANTED',
          method: input.method,
          evidence: input.evidence || null,
          grantedAt: new Date(),
          isMinor: Boolean(input.isMinor),
          guardianName: input.guardianName || null,
          guardianRelation: input.guardianRelation || null,
          guardianVerification: input.guardianVerification || null,
          capturedBy: getUserId() || null,
          ipAddress: ip || null,
          userAgent: userAgent ? String(userAgent).slice(0, 300) : null,
        },
        { transaction }
      );
    });
  }

  /**
   * Withdrawal (s.6(4)) — as easy as giving it. Processing for that purpose
   * stops, and where nothing else justifies keeping the data an erasure request
   * is opened so a person sees it through (s.6(6), s.8(7)(a)).
   */
  static async withdrawConsent(id, options = {}) {
    if (!getTenantId()) {
      // The owner's desk: find which organisation holds it, then act as that one.
      const row = await ConsentRecord.unscoped().findByPk(id, { attributes: ['id', 'tenantId'] });
      if (!row) throw new NotFoundError('Consent record not found');
      return asTenant(row.tenantId, () => this.withdrawConsent(id, options));
    }
    const { reason, channel = 'IN_APP' } = options;
    return sequelize.transaction(async (transaction) => {
      const consent = await ConsentRecord.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!consent) throw new NotFoundError('Consent record not found');
      if (consent.status === 'WITHDRAWN') return { consent, erasureRequest: null };
      await consent.update({ status: 'WITHDRAWN', withdrawnAt: new Date(), withdrawalReason: reason || null }, { transaction });

      let erasureRequest = null;
      const remaining = consent.principalId
        ? await ConsentRecord.count({ where: { principalType: consent.principalType, principalId: consent.principalId, status: 'GRANTED' }, transaction })
        : 0;
      // A lead exists only on consent; with none left there is no reason to hold it.
      if (consent.principalType === 'LEAD' && consent.principalId && remaining === 0) {
        const { RequestsService } = require('./requests.service');
        const erasure = {
          type: 'ERASURE',
          channel,
          principalType: 'LEAD',
          principalId: consent.principalId,
          requesterName: consent.principalName || 'Enquirer',
          requesterRelation: 'SELF',
          details: `Opened automatically: consent for ${consent.purposeCode} was withdrawn and no other consent remains.`,
        };
        erasureRequest = await RequestsService.create(erasure, { transaction });
      }
      return { consent, erasureRequest };
    });
  }

  // --------------------------------------------------------------- nominees

  static async nomineeFor(principalType, principalId) {
    return PrivacyNominee.findOne({ where: { principalType, principalId, revokedAt: null } });
  }

  static async setNominee(principalType, principalId, input) {
    return sequelize.transaction(async (transaction) => {
      const current = await PrivacyNominee.findOne({ where: { principalType, principalId, revokedAt: null }, transaction, lock: transaction.LOCK.UPDATE });
      if (current) await current.update({ revokedAt: new Date() }, { transaction });
      if (!input) return null;
      return PrivacyNominee.create({ principalType, principalId, ...input, createdBy: getUserId() || null }, { transaction });
    });
  }

  // --------------------------------------------------------------- self-service

  static async myPrivacy(userId) {
    const [profile, notice, consents, nominee, requests] = await Promise.all([
      this.getProfile(),
      this.getPublishedNotice(),
      this.consentsFor('USER', userId),
      this.nomineeFor('USER', userId),
      DataPrincipalRequest.findAll({
        where: { [Op.or]: [{ submittedByUserId: userId }, { principalType: 'USER', principalId: userId }] },
        order: [['receivedAt', 'DESC']],
      }),
    ]);
    const ack = notice ? await NoticeAcknowledgement.findOne({ where: { userId, noticeId: notice.id } }) : null;
    return {
      profile,
      notice,
      acknowledgement: ack,
      acknowledgementPending: Boolean(notice && !ack),
      consents,
      nominee,
      requests,
    };
  }

  // --------------------------------------------------------------- overview

  /**
   * The compliance dashboard: each obligation and whether the records show it
   * being met. Items are facts from the database, not self-assessment.
   */
  static async overview() {
    const now = new Date();
    const [profile, notice, openRequests, overdueRequests, openBreaches, retentionRules] = await Promise.all([
      PrivacyProfile.findOne(),
      this.getPublishedNotice(),
      DataPrincipalRequest.count({ where: { status: { [Op.in]: ['RECEIVED', 'VERIFYING', 'IN_PROGRESS'] } } }),
      DataPrincipalRequest.count({ where: { status: { [Op.in]: ['RECEIVED', 'VERIFYING', 'IN_PROGRESS'] }, dueDate: { [Op.lt]: today() } } }),
      DataBreach.findAll({ where: { status: { [Op.ne]: 'CLOSED' } }, order: [['boardReportDueAt', 'ASC']] }),
      RetentionRule.findAll(),
    ]);
    const coverage = await this.acknowledgementCoverage(notice?.id);

    // Minors among parties (labour mostly) without a guardian's consent on record.
    const minorCutoff = (() => {
      const [y, m, d] = today().split('-').map(Number);
      return `${y - 18}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    })();
    // Across every organisation, so raw SQL: the model hides tenantId.
    const minors = await sequelize.query(
      `SELECT p.id, p.name, p."partyType", t.name AS "organisationName"
         FROM parties p JOIN tenants t ON t.id = p."tenantId"
        WHERE p."dateOfBirth" > :cutoff AND p."erasedAt" IS NULL`,
      { replacements: { cutoff: minorCutoff }, type: QueryTypes.SELECT }
    );
    const guarded = minors.length
      ? await ConsentRecord.findAll({
        where: { principalType: 'PARTY', principalId: { [Op.in]: minors.map((p) => p.id) }, status: 'GRANTED', isMinor: true },
        attributes: ['principalId'],
      })
      : [];
    const guardedIds = new Set(guarded.map((c) => c.principalId));
    const unguardedMinors = minors.filter((p) => !guardedIds.has(p.id)).map((p) => ({ id: p.id, name: p.name, partyType: p.partyType, organisationName: p.organisationName }));

    const oldestAudit = await AuditLog.min('createdAt');
    const breachesPastDue = openBreaches.filter((b) => !b.boardReportSubmittedAt && new Date(b.boardReportDueAt) < now);

    const checks = [
      {
        key: 'contact',
        label: 'Privacy contact published',
        reference: 's.8(9), Rules r.9',
        ok: Boolean(profile && profile.contactName && profile.contactEmail),
        detail: profile?.contactEmail ? `${profile.contactName || ''} <${profile.contactEmail}>` : 'No one is named to answer questions about personal data.',
      },
      {
        key: 'notice',
        label: 'Itemised privacy notice in force',
        reference: 's.5, Rules r.3',
        ok: Boolean(notice),
        detail: notice ? `Version ${notice.version}, published ${isoDateInZone(notice.publishedAt, env.APP_TIMEZONE)}` : 'No notice has been published.',
      },
      {
        key: 'acknowledgement',
        label: 'Staff have seen the current notice',
        reference: 's.5(1)',
        ok: Boolean(notice) && coverage.acknowledged >= coverage.activeUsers,
        detail: `${coverage.acknowledged} of ${coverage.activeUsers} active users`,
      },
      {
        key: 'requests',
        label: 'Requests answered on time',
        reference: 'ss.11-14, Rules r.14(3)',
        ok: overdueRequests === 0,
        detail: `${openRequests} open, ${overdueRequests} overdue`,
      },
      {
        key: 'breaches',
        label: 'Breaches reported to the Board within 72 hours',
        reference: 's.8(6), Rules r.7',
        ok: breachesPastDue.length === 0,
        detail: openBreaches.length ? `${openBreaches.length} open, ${breachesPastDue.length} past the 72-hour report` : 'No open breaches',
      },
      {
        key: 'retention',
        label: 'Retention schedule switched on',
        reference: 's.8(7), Rules r.8',
        ok: retentionRules.some((r) => r.enabled),
        detail: `${retentionRules.filter((r) => r.enabled).length} of ${retentionRules.length || 'the'} rules enabled`,
      },
      {
        key: 'children',
        label: "Children's data has a guardian's consent",
        reference: 's.9, Rules r.10',
        ok: unguardedMinors.length === 0,
        detail: unguardedMinors.length ? `${unguardedMinors.length} under-18 record(s) without verified guardian consent` : 'No under-18 records without consent',
      },
      {
        key: 'logs',
        label: 'Processing logs kept for a year',
        reference: 'Rules r.6(1)(e), r.8(3)',
        ok: true,
        detail: oldestAudit ? `Audit trail since ${isoDateInZone(oldestAudit, env.APP_TIMEZONE)}; nothing purges it before a year` : 'Audit trail is empty',
      },
      {
        key: 'transport',
        label: 'Database connection encrypted',
        reference: 's.8(5), Rules r.6(1)(a)',
        ok: String(process.env.DB_SSL) === 'true',
        detail: String(process.env.DB_SSL) === 'true' ? 'DB_SSL is on' : 'DB_SSL is off: personal data crosses the network to the database unencrypted.',
      },
    ];

    return {
      checks,
      score: { met: checks.filter((c) => c.ok).length, total: checks.length },
      openRequests,
      overdueRequests,
      openBreaches,
      unguardedMinors,
    };
  }
}

module.exports = { PrivacyService, describePrincipal, ageOn, PRINCIPAL_MODELS, today };
