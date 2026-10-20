const { Op, UniqueConstraintError } = require('sequelize');
const { sequelize } = require('../../config/database');
const { DataPrincipalRequest, ConsentRecord, PrivacyNominee, NoticeAcknowledgement } = require('./privacy.model');
const { PrivacyService, describePrincipal, today } = require('./privacy.service');
const { ErasureService } = require('./erasure.service');
const { User } = require('../users/user.model');
const { EmployeeDocument } = require('../users/employeeDocument.model');
const { LeaveRequest, StaffAttendance } = require('../hr/hr.model');
const { Party } = require('../parties/party.model');
const { PartyAddress } = require('../parties/partyAddress.model');
const { Lead, LeadActivity } = require('../crm/lead.model');
const { Quotation } = require('../quotations/quotation.model');
const { SalesInvoice } = require('../invoicing/salesInvoice.model');
const { SalesOrder } = require('../sales/salesOrder.model');
const { AttendanceRecord } = require('../workforce/attendanceRecord.model');
const { AuditLog } = require('../audit/auditLog.model');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { getTenantId, getUserId, getIp } = require('../../core/tenantContext');
const { searchWhere } = require('../../utils/pagination');
const { asTenant } = require('../../core/platformOwner');
const { Tenant } = require('../organization/tenant.model');

/**
 * Requests from Data Principals (ss.11-14): access, correction, erasure,
 * nomination, grievance, and withdrawal of consent.
 *
 * The workflow is deliberately short — received, identity checked, done — but
 * two steps cannot be skipped. Nothing about a person is disclosed or erased
 * until someone has checked the requester is that person (or their nominee or
 * guardian), and every request has a due date set the moment it arrives, from
 * the response time the business publishes (at most 90 days, Rules r.14(3)).
 *
 * Requests are the application owner's to answer, across every organisation.
 * One from the public form names no organisation, so tenantId starts null and
 * the owner sets it when linking the request to the person's record. Anything
 * that reads or changes that record runs as its organisation (asTenant), so
 * the tenant-scoped models and the audit trail behave as they always do.
 */

const OPEN = ['RECEIVED', 'VERIFYING', 'IN_PROGRESS'];
const NEEDS_VERIFICATION = ['ACCESS', 'CORRECTION', 'ERASURE', 'NOMINATION', 'CONSENT_WITHDRAWAL'];
const NEEDS_PRINCIPAL = ['ACCESS', 'ERASURE', 'NOMINATION', 'CONSENT_WITHDRAWAL'];

const addDays = (isoDate, days) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

const ORG_INCLUDE = { model: Tenant, as: 'organisation', attributes: ['id', 'name'] };

/** Runs fn as tenantId, unless that is already the organisation in context. */
const inTenant = (tenantId, fn) => (getTenantId() === tenantId ? fn() : asTenant(tenantId, fn));

const nextNumber = async (transaction) => {
  const year = today().slice(0, 4);
  const prefix = `DPR/${year}/`;
  const count = await DataPrincipalRequest.count({ where: { requestNumber: { [Op.like]: `${prefix}%` } }, transaction });
  return `${prefix}${String(count + 1).padStart(4, '0')}`;
};

class RequestsService {
  static async list(page, limit, { tenantId, status, type, openOnly, overdueOnly, search } = {}) {
    const where = {};
    if (tenantId) where.tenantId = tenantId;
    if (status) where.status = status;
    if (type) where.type = type;
    if (openOnly || overdueOnly) where.status = { [Op.in]: OPEN };
    if (overdueOnly) where.dueDate = { [Op.lt]: today() };
    if (search) Object.assign(where, searchWhere(search, ['requestNumber', 'requesterName', 'requesterEmail', 'requesterPhone']));
    const { rows, count } = await DataPrincipalRequest.findAndCountAll({
      where,
      limit,
      offset: (page - 1) * limit,
      include: [{ model: User, as: 'assignee', attributes: ['id', 'firstName', 'lastName'] }, ORG_INCLUDE],
      order: [['receivedAt', 'DESC']],
    });
    return { rows: rows.map((r) => this.view(r)), count };
  }

  static view(request) {
    const json = typeof request.toJSON === 'function' ? request.toJSON() : request;
    return {
      ...json,
      isOpen: OPEN.includes(json.status),
      isOverdue: OPEN.includes(json.status) && json.dueDate < today(),
      assigneeName: json.assignee ? [json.assignee.firstName, json.assignee.lastName].filter(Boolean).join(' ') : null,
      organisationName: json.organisation ? json.organisation.name : null,
    };
  }

  static async get(id, transaction) {
    const request = await DataPrincipalRequest.findByPk(id, {
      include: [{ model: User, as: 'assignee', attributes: ['id', 'firstName', 'lastName'] }, ORG_INCLUDE],
      transaction,
    });
    if (!request) throw new NotFoundError('Request not found');
    return request;
  }

  /** Records a request. The number is retried once if two arrive in the same instant. */
  static async create(input, { transaction } = {}) {
    const tenantId = input.tenantId || getTenantId() || null;
    if (input.principalId && !tenantId) throw new ValidationError("Choose the organisation that holds this person's record");
    if (input.tenantId && !(await Tenant.findByPk(input.tenantId, { attributes: ['id'], transaction }))) {
      throw new NotFoundError('Organisation not found');
    }
    const run = async (t) => {
      if (input.principalId) await inTenant(tenantId, () => describePrincipal(input.principalType, input.principalId, t));
      const profile = await PrivacyService.getProfile(t);
      const receivedOn = today();
      for (let attempt = 0; ; attempt += 1) {
        try {
          return await DataPrincipalRequest.create(
            {
              tenantId,
              requesterOrganisation: input.requesterOrganisation || null,
              requestNumber: await nextNumber(t),
              type: input.type,
              channel: input.channel,
              principalType: input.principalType || null,
              principalId: input.principalId || null,
              requesterName: input.requesterName,
              requesterEmail: input.requesterEmail || null,
              requesterPhone: input.requesterPhone || null,
              requesterRelation: input.requesterRelation || 'SELF',
              details: input.details || null,
              status: 'RECEIVED',
              receivedAt: new Date(),
              dueDate: addDays(receivedOn, Number(profile.responseDays) || 30),
              // A signed-in user asking about themselves is already identified.
              ...(input.selfVerified ? { identityVerifiedAt: new Date(), verificationNote: 'Signed-in user acting on their own record' } : {}),
              submittedByUserId: input.submittedByUserId || null,
              createdBy: getUserId() || null,
            },
            { transaction: t }
          );
        } catch (error) {
          if (!(error instanceof UniqueConstraintError) || attempt >= 2 || transaction) throw error;
        }
      }
    };
    return transaction ? run(transaction) : sequelize.transaction(run);
  }

  /** Assignment, linking to the person's record, and notes — not the outcome. */
  static async update(id, input) {
    const request = await this.get(id);
    if (!OPEN.includes(request.status)) throw new ValidationError('This request is closed');
    const tenantId = input.tenantId || request.tenantId;
    if (input.tenantId && !(await Tenant.findByPk(input.tenantId, { attributes: ['id'] }))) throw new NotFoundError('Organisation not found');
    if (input.principalId) {
      if (!tenantId) throw new ValidationError("Choose the organisation that holds this person's record");
      await inTenant(tenantId, () => describePrincipal(input.principalType || request.principalType, input.principalId));
    }
    if (input.assignedTo) {
      const assignee = await User.findByPk(input.assignedTo, { attributes: ['id'] });
      if (!assignee) throw new NotFoundError('Assignee not found');
    }
    const values = { ...input };
    // Moving to another organisation unlinks a record that belongs to the old one.
    if (input.tenantId && input.tenantId !== request.tenantId && !input.principalId) {
      values.principalType = null;
      values.principalId = null;
    }
    if (request.status === 'RECEIVED' && (input.assignedTo || input.principalId)) values.status = 'VERIFYING';
    await request.update(values);
    return this.view(await this.get(id));
  }

  static async verifyIdentity(id, note) {
    const request = await this.get(id);
    if (!OPEN.includes(request.status)) throw new ValidationError('This request is closed');
    await request.update({
      identityVerifiedAt: new Date(),
      identityVerifiedBy: getUserId() || null,
      verificationNote: note,
      status: 'IN_PROGRESS',
    });
    return this.view(await this.get(id));
  }

  static async reject(id, reason) {
    const request = await this.get(id);
    if (!OPEN.includes(request.status)) throw new ValidationError('This request is closed');
    await request.update({ status: 'REJECTED', resolution: reason, completedAt: new Date(), completedBy: getUserId() || null });
    return this.view(await this.get(id));
  }

  /**
   * Closes a request with what was done. Erasure and consent withdrawal act on
   * the record here, inside the same transaction as the status change, so a
   * request can never say COMPLETED for an erasure that did not happen.
   */
  static async complete(id, { resolution, nominee, purposeCode } = {}) {
    return sequelize.transaction(async (transaction) => {
      const request = await DataPrincipalRequest.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!request) throw new NotFoundError('Request not found');
      if (!OPEN.includes(request.status)) throw new ValidationError('This request is closed');
      if (NEEDS_VERIFICATION.includes(request.type) && !request.identityVerifiedAt) {
        throw new ValidationError("Verify the requester's identity before completing this request");
      }
      if (NEEDS_PRINCIPAL.includes(request.type) && !request.principalId) {
        throw new ValidationError('Link the request to the person\'s record first');
      }

      // What follows changes that organisation's records, so it runs as it.
      const act = () => this.carryOut(request, { resolution, nominee, purposeCode }, transaction);
      const outcome = request.tenantId ? await inTenant(request.tenantId, act) : await act();

      await request.update(
        { status: 'COMPLETED', resolution: resolution || null, outcome, completedAt: new Date(), completedBy: getUserId() || null },
        { transaction }
      );
      return request;
    }).then((request) => this.get(request.id)).then((r) => this.view(r));
  }

  /** The part of completing a request that acts on the person's record. */
  static async carryOut(request, { resolution, nominee, purposeCode }, transaction) {
    let outcome = null;
    switch (request.type) {
      case 'ERASURE':
        outcome = await ErasureService.erase(request.principalType, request.principalId, {
          reason: `Request ${request.requestNumber}`,
          transaction,
        });
        break;
      case 'CONSENT_WITHDRAWAL': {
        const where = { principalType: request.principalType, principalId: request.principalId, status: 'GRANTED' };
        if (purposeCode) where.purposeCode = purposeCode;
        const consents = await ConsentRecord.findAll({ where, transaction });
        for (const consent of consents) {
          await consent.update({ status: 'WITHDRAWN', withdrawnAt: new Date(), withdrawalReason: `Request ${request.requestNumber}` }, { transaction });
        }
        outcome = { consentsWithdrawn: consents.map((c) => c.purposeCode) };
        break;
      }
      case 'NOMINATION': {
        if (!nominee || !nominee.nomineeName) throw new ValidationError('Give the nominee\'s name to record the nomination');
        const current = await PrivacyNominee.findOne({
          where: { principalType: request.principalType, principalId: request.principalId, revokedAt: null },
          transaction,
        });
        if (current) await current.update({ revokedAt: new Date() }, { transaction });
        const created = await PrivacyNominee.create(
          { principalType: request.principalType, principalId: request.principalId, ...nominee, createdBy: getUserId() || null },
          { transaction }
        );
        outcome = { nomineeId: created.id };
        break;
      }
      case 'ACCESS':
        outcome = { note: 'Summary provided to the requester', exportedAt: new Date().toISOString() };
        break;
      default:
        if (!resolution) throw new ValidationError('Describe what was done');
    }
    return outcome;
  }

  /**
   * Everything held about one person, for an access request (s.11): their own
   * fields unmasked (it is their data), what it is used for, who else
   * processes it, and the records it appears on. Every export is logged.
   */
  static async compilePersonalData(principalType, principalId, tenantId) {
    // From the owner's desk: read as the organisation that holds the record.
    if (tenantId && tenantId !== getTenantId()) return asTenant(tenantId, () => this.compilePersonalData(principalType, principalId, tenantId));
    if (!getTenantId()) throw new ValidationError('Choose the organisation that holds this person\'s record');
    let personal;
    let records = {};

    if (principalType === 'USER') {
      const user = await User.findByPk(principalId);
      if (!user) throw new NotFoundError('User not found');
      personal = user.toJSON();
      const [documents, leave, attendanceDays, acknowledgements] = await Promise.all([
        EmployeeDocument.findAll({ where: { employeeId: principalId }, attributes: ['documentType', 'fileName', 'createdAt', 'isVerified'] }),
        LeaveRequest.findAll({ where: { employeeId: principalId }, attributes: ['fromDate', 'toDate', 'days', 'reason', 'status'] }),
        StaffAttendance.count({ where: { employeeId: principalId } }),
        NoticeAcknowledgement.findAll({ where: { userId: principalId }, attributes: ['noticeVersion', 'acknowledgedAt'] }),
      ]);
      records = { documents, leaveRequests: leave, attendanceDaysRecorded: attendanceDays, noticeAcknowledgements: acknowledgements };
    } else if (principalType === 'PARTY') {
      const party = await Party.scope('withSensitive').findByPk(principalId);
      if (!party) throw new NotFoundError('Party not found');
      personal = party.toJSON();
      const [addresses, invoices, orders, attendanceDays] = await Promise.all([
        PartyAddress.findAll({ where: { partyId: principalId } }),
        SalesInvoice.count({ where: { customerPartyId: principalId } }),
        SalesOrder.count({ where: { customerPartyId: principalId } }),
        AttendanceRecord.count({ where: { labourPartyId: principalId } }),
      ]);
      records = { addresses, salesInvoices: invoices, salesOrders: orders, attendanceDaysRecorded: attendanceDays };
    } else if (principalType === 'LEAD') {
      const lead = await Lead.findByPk(principalId);
      if (!lead) throw new NotFoundError('Lead not found');
      personal = lead.toJSON();
      const [activities, quotations] = await Promise.all([
        LeadActivity.findAll({ where: { leadId: principalId }, attributes: ['type', 'subject', 'detail', 'occurredAt'] }),
        Quotation.findAll({ where: { leadId: principalId }, attributes: ['quotationNumber', 'quotationDate', 'status'] }),
      ]);
      records = { activities, quotations };
    } else {
      throw new ValidationError('Only staff, party and lead records can be exported');
    }

    delete personal.tenantId;
    const [profile, notice, consents, nominee] = await Promise.all([
      PrivacyService.getProfile(),
      PrivacyService.getPublishedNotice(),
      ConsentRecord.findAll({ where: { principalType, principalId } }),
      PrivacyNominee.findOne({ where: { principalType, principalId, revokedAt: null } }),
    ]);

    await AuditLog.create({
      tenantId: getTenantId(),
      userId: getUserId() || null,
      ipAddress: getIp() || null,
      entityType: principalType === 'USER' ? 'User' : principalType === 'PARTY' ? 'Party' : 'Lead',
      entityId: principalId,
      action: 'EXPORT_PERSONAL_DATA',
      afterSnapshot: { principalType },
    });

    return {
      generatedAt: new Date().toISOString(),
      dataFiduciaryContact: profile && profile.contactEmail
        ? { name: profile.contactName, designation: profile.contactDesignation, email: profile.contactEmail, phone: profile.contactPhone }
        : null,
      personalData: personal,
      relatedRecords: records,
      purposes: (notice?.purposes || []).filter((p) => !p.principalTypes || p.principalTypes.includes(principalType)),
      sharedWith: notice?.processors || [],
      consents,
      nominee,
    };
  }
}

module.exports = { RequestsService, OPEN_REQUEST_STATUSES: OPEN };
