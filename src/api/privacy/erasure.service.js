const fs = require('fs');
const path = require('path');
const { Op, QueryTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Lead, LeadActivity } = require('../crm/lead.model');
const { Quotation } = require('../quotations/quotation.model');
const { Party } = require('../parties/party.model');
const { PartyAddress } = require('../parties/partyAddress.model');
const { SENSITIVE_FIELDS } = require('../parties/partySensitive');
const { User } = require('../users/user.model');
const { EmployeeDocument } = require('../users/employeeDocument.model');
const { LeaveRequest, StaffAttendance } = require('../hr/hr.model');
const { RefreshToken } = require('../auth/refreshToken.model');
const { AuditLog } = require('../audit/auditLog.model');
const { ConsentRecord, PrivacyNominee } = require('./privacy.model');
const { removeAvatarFile } = require('../users/user.service');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { getTenantId, getUserId, getIp } = require('../../core/tenantContext');
const { EmployeeStatus } = require('../../utils/constants');
const { logger } = require('../../utils/logger');

/**
 * Erasure under s.8(7) and s.12(3).
 *
 * "Erase" here means the personal fields are wiped in place; the row stays.
 * Invoices, wage registers, ledgers and the audit trail are records the
 * business must keep by law (CGST Act s.36, the Code on Wages, the Companies
 * and Income-tax Acts), and s.8(7) exempts retention "necessary for compliance
 * with any law". So a customer keeps the name and state their invoices were
 * raised in, a former employee keeps the name the audit trail attributes their
 * actions to, and everything else that identifies or reaches them goes.
 *
 * Three things make it an erasure rather than an edit:
 *
 *  - The model writes skip the audit hooks. An ordinary update would copy every
 *    value being erased into `beforeSnapshot`, i.e. store it again. One ERASE
 *    row records which fields went, never what they held.
 *  - Earlier audit rows about the same records have those fields masked, since
 *    the trail would otherwise be a full copy of what was erased.
 *  - Files (documents, avatar) are deleted from disk once the transaction commits.
 */

const ERASED = '[erased]';

const LEAD_FIELDS = ['contactName', 'phone', 'email', 'city', 'state', 'requirement', 'lostReason'];
const LEAD_ACTIVITY_FIELDS = ['subject', 'detail'];
const QUOTATION_FIELDS = ['prospectName', 'prospectPhone'];
const PARTY_FIELDS = [
  'phone', 'email', 'address', 'billingAddress', 'city', 'pincode', 'bankName', 'bankBranch',
  'gender', 'badgeNumber', ...SENSITIVE_FIELDS,
];
const PARTY_ADDRESS_FIELDS = ['contactPerson', 'phone', 'line1', 'line2', 'pincode'];
const USER_FIELDS = ['email', 'phone', 'address', 'city', 'state', 'pincode', 'gender', 'avatar'];
const LEAVE_FIELDS = ['reason', 'decisionNote'];
const SESSION_FIELDS = ['email', 'userAgent'];

/** Every personal key that can appear in an audit snapshot, for the time-based mask. */
const AUDIT_PERSONAL_KEYS = Array.from(
  new Set([
    ...LEAD_FIELDS, ...QUOTATION_FIELDS, ...PARTY_FIELDS, ...PARTY_ADDRESS_FIELDS,
    ...USER_FIELDS, ...LEAVE_FIELDS, 'userAgent', 'principalContact', 'requesterEmail',
    'requesterPhone', 'nomineeEmail', 'nomineePhone', 'driverPhone', 'driverLicenseNumber', 'note',
  ])
);

/**
 * Replaces `keys` in a JSONB snapshot with "[erased]", leaving every other key
 * as it was. Null-safe: a null snapshot stays null.
 */
const maskedSnapshotSql = (column) => `
  CASE WHEN "${column}" IS NULL OR jsonb_typeof("${column}") <> 'object' THEN "${column}"
  ELSE (
    SELECT COALESCE(jsonb_object_agg(k, CASE WHEN k = ANY(ARRAY[:keys]::text[]) AND v <> 'null'::jsonb THEN to_jsonb(:erased::text) ELSE v END), '{}'::jsonb)
    FROM jsonb_each("${column}") AS e(k, v)
  ) END`;

const maskAuditRows = async ({ entityType, entityIds, keys, before, transaction }) => {
  if ((entityIds && !entityIds.length) || !keys.length) return 0;
  const conditions = ['"tenantId" = :tenantId', '("beforeSnapshot" ?| ARRAY[:keys]::text[] OR "afterSnapshot" ?| ARRAY[:keys]::text[])'];
  if (entityType) conditions.push('"entityType" = :entityType');
  if (entityIds) conditions.push('"entityId" IN (:entityIds)');
  if (before) conditions.push('"createdAt" < :before');
  const [, result] = await sequelize.query(
    `UPDATE audit_logs SET "beforeSnapshot" = ${maskedSnapshotSql('beforeSnapshot')}, "afterSnapshot" = ${maskedSnapshotSql('afterSnapshot')}
     WHERE ${conditions.join(' AND ')}`,
    {
      replacements: { tenantId: getTenantId(), keys, erased: ERASED, entityType: entityType || null, entityIds: entityIds || null, before: before || null },
      type: QueryTypes.UPDATE,
      transaction,
    }
  );
  return typeof result === 'number' ? result : (result && result.rowCount) || 0;
};

/** The one audit row an erasure leaves: field names, never values. */
const recordErasure = (entityType, entityId, fields, reason, transaction) =>
  AuditLog.create(
    {
      tenantId: getTenantId(),
      userId: getUserId() || null,
      ipAddress: getIp() || null,
      entityType,
      entityId,
      action: 'ERASE',
      beforeSnapshot: null,
      afterSnapshot: { fields, reason },
    },
    { transaction }
  );

/** hooks:false also skips BaseScopedModel's tenant filter, so bulk writes name the tenant themselves. */
const scoped = (where) => ({ ...where, tenantId: getTenantId() });

const nulls = (fields) => Object.fromEntries(fields.map((f) => [f, null]));

/** Consent rows are the evidence a consent existed, so they stay — without a way to reach the person. */
const scrubConsentsAndNominees = async (principalType, principalId, transaction) => {
  const [consents] = await ConsentRecord.update(
    { principalContact: null, ipAddress: null, userAgent: null },
    { where: scoped({ principalType, principalId }), transaction, hooks: false }
  );
  const nominees = await PrivacyNominee.destroy({ where: scoped({ principalType, principalId }), transaction, hooks: false });
  return { consentRecordsScrubbed: consents, nomineesRemoved: nominees };
};

const eraseLead = async (id, { reason, transaction }) => {
  const lead = await Lead.findByPk(id, { transaction });
  if (!lead) throw new NotFoundError('Lead not found');
  if (lead.erasedAt) return { alreadyErased: true, erasedAt: lead.erasedAt };

  await lead.update(
    { ...nulls(LEAD_FIELDS), name: `Erased enquiry ${lead.leadNumber}`, erasedAt: new Date() },
    { transaction, hooks: false }
  );
  const activities = await LeadActivity.findAll({ where: { leadId: id }, attributes: ['id'], transaction });
  await LeadActivity.update({ subject: ERASED, detail: null }, { where: scoped({ leadId: id }), transaction, hooks: false });
  const quotations = await Quotation.findAll({ where: { leadId: id }, attributes: ['id'], transaction });
  await Quotation.update(nulls(QUOTATION_FIELDS), { where: scoped({ leadId: id }), transaction, hooks: false });

  const auditRowsMasked =
    (await maskAuditRows({ entityType: 'Lead', entityIds: [id], keys: [...LEAD_FIELDS, 'name'], transaction })) +
    (await maskAuditRows({ entityType: 'LeadActivity', entityIds: activities.map((a) => a.id), keys: LEAD_ACTIVITY_FIELDS, transaction })) +
    (await maskAuditRows({ entityType: 'Quotation', entityIds: quotations.map((q) => q.id), keys: QUOTATION_FIELDS, transaction }));

  const scrubbed = await scrubConsentsAndNominees('LEAD', id, transaction);
  await recordErasure('Lead', id, [...LEAD_FIELDS, 'name'], reason, transaction);

  return {
    fieldsErased: [...LEAD_FIELDS, 'name'],
    recordsTouched: { lead: 1, activities: activities.length, quotations: quotations.length },
    auditRowsMasked,
    ...scrubbed,
    retained: 'Enquiry number, status, dates, estimated value and linked quotations (business records).',
  };
};

const eraseParty = async (id, { reason, transaction }) => {
  const party = await Party.scope('withSensitive').findByPk(id, { transaction });
  if (!party) throw new NotFoundError('Party not found');
  if (party.erasedAt) return { alreadyErased: true, erasedAt: party.erasedAt };

  await party.update({ ...nulls(PARTY_FIELDS), status: 'inactive', erasedAt: new Date() }, { transaction, hooks: false });
  const addresses = await PartyAddress.findAll({ where: { partyId: id }, attributes: ['id'], transaction });
  // line1 is required, and a delivery challan may still point at the address row.
  await PartyAddress.update(
    { contactPerson: null, phone: null, line1: ERASED, line2: null, pincode: null },
    { where: scoped({ partyId: id }), transaction, hooks: false }
  );

  const auditRowsMasked =
    (await maskAuditRows({ entityType: 'Party', entityIds: [id], keys: PARTY_FIELDS, transaction })) +
    (await maskAuditRows({ entityType: 'PartyAddress', entityIds: addresses.map((a) => a.id), keys: PARTY_ADDRESS_FIELDS, transaction }));

  const scrubbed = await scrubConsentsAndNominees('PARTY', id, transaction);
  await recordErasure('Party', id, PARTY_FIELDS, reason, transaction);

  return {
    fieldsErased: PARTY_FIELDS,
    recordsTouched: { party: 1, addresses: addresses.length },
    auditRowsMasked,
    ...scrubbed,
    retained:
      'Name, GSTIN, state, invoices, payments, attendance and wages: tax, GST and wage law require these records to be kept.',
  };
};

const INACTIVE_STATUSES = [EmployeeStatus.INACTIVE, EmployeeStatus.TERMINATED];

const eraseUser = async (id, { reason, transaction }) => {
  const user = await User.findByPk(id, { transaction });
  if (!user) throw new NotFoundError('User not found');
  if (user.erasedAt) return { alreadyErased: true, erasedAt: user.erasedAt };
  if (user.isSystem) throw new ValidationError('A system account cannot be erased');
  if (user.id === getUserId()) throw new ValidationError('You cannot erase your own account');
  // An active login is still being used for employment; HR deactivates it first.
  if (!INACTIVE_STATUSES.includes(user.status)) {
    throw new ValidationError('Deactivate this employee (status Inactive or Terminated) before erasing their details');
  }

  const avatar = user.avatar;
  const documents = await EmployeeDocument.findAll({ where: { employeeId: id }, attributes: ['id'], transaction });

  await user.update(
    {
      ...nulls(USER_FIELDS.filter((f) => f !== 'email')),
      // Login is unique and NOT NULL; the address must stop reaching the person.
      email: `erased-${user.id}@erased.invalid`,
      erasedAt: new Date(),
    },
    { transaction, hooks: false }
  );
  await EmployeeDocument.destroy({ where: { employeeId: id }, transaction });
  const leaves = await LeaveRequest.findAll({ where: { employeeId: id }, attributes: ['id'], transaction });
  await LeaveRequest.update(nulls(LEAVE_FIELDS), { where: scoped({ employeeId: id }), transaction, hooks: false });
  const attendance = await StaffAttendance.findAll({ where: { employeeId: id, note: { [Op.ne]: null } }, attributes: ['id'], transaction });
  await StaffAttendance.update({ note: null }, { where: scoped({ employeeId: id }), transaction, hooks: false });
  await RefreshToken.destroy({ where: { userId: id }, transaction });

  const auditRowsMasked =
    (await maskAuditRows({ entityType: 'User', entityIds: [id], keys: USER_FIELDS, transaction })) +
    (await maskAuditRows({ entityType: 'Session', entityIds: [id], keys: SESSION_FIELDS, transaction })) +
    (await maskAuditRows({ entityType: 'LeaveRequest', entityIds: leaves.map((l) => l.id), keys: LEAVE_FIELDS, transaction })) +
    (await maskAuditRows({ entityType: 'StaffAttendance', entityIds: attendance.map((a) => a.id), keys: ['note'], transaction }));

  const scrubbed = await scrubConsentsAndNominees('USER', id, transaction);
  await recordErasure('User', id, USER_FIELDS, reason, transaction);

  // Files go once the rows are gone for good; a rollback must not leave rows pointing at nothing.
  const removeFiles = async () => {
    if (avatar) await removeAvatarFile(avatar).catch(() => {});
    const dir = path.join(__dirname, '../../../uploads/employees', String(id));
    await fs.promises.rm(dir, { recursive: true, force: true }).catch((error) => {
      logger.error({ message: 'Erasure: could not remove employee documents folder', error: error.message });
    });
  };
  if (transaction && typeof transaction.afterCommit === 'function') transaction.afterCommit(removeFiles);
  else await removeFiles();

  return {
    fieldsErased: USER_FIELDS,
    recordsTouched: { user: 1, documents: documents.length, leaveRequests: leaves.length, attendanceNotes: attendance.length },
    auditRowsMasked,
    ...scrubbed,
    retained: 'Name, employee code, role and dates of employment, so the audit trail and statutory registers still say who did what.',
  };
};

const ERASERS = { LEAD: eraseLead, PARTY: eraseParty, USER: eraseUser };

class ErasureService {
  static get ERASABLE_TYPES() {
    return Object.keys(ERASERS);
  }

  /**
   * Erases one person's record. Runs in its own transaction unless one is
   * passed, so a failure part-way leaves nothing half-erased.
   */
  static async erase(principalType, principalId, { reason = 'Erasure request', transaction } = {}) {
    const eraser = ERASERS[principalType];
    if (!eraser) throw new ValidationError(`Records of type ${principalType} cannot be erased automatically`);
    if (transaction) return { principalType, principalId, ...(await eraser(principalId, { reason, transaction })) };
    return sequelize.transaction(async (t) => ({ principalType, principalId, ...(await eraser(principalId, { reason, transaction: t })) }));
  }

  /** Masks personal values in audit snapshots older than `before`, across the tenant. */
  static maskOldAuditSnapshots(before) {
    return maskAuditRows({ keys: AUDIT_PERSONAL_KEYS, before });
  }
}

module.exports = { ErasureService, ERASED, AUDIT_PERSONAL_KEYS, INACTIVE_STATUSES };
