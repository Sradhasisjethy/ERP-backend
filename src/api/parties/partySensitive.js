const { hasPermission } = require('../../middlewares/authorize');

/**
 * Identity and bank details on a party. PARTY_READ is held by store keepers,
 * sales, purchase, accountants and plant managers, who need a party's name and
 * GSTIN to do their job — not a labourer's Aadhaar or a vendor's account
 * number. GSTIN, PAN-derived entity type, Udyam and PF establishment codes are
 * public business identifiers and stay readable.
 *
 * The Party defaultScope excludes these, so every `{ model: Party, as: ... }`
 * include across the system stops carrying them; the parties endpoints load
 * them through the `withSensitive` scope and mask them here.
 */
const SENSITIVE_FIELDS = Object.freeze([
  'aadhaarNumber',
  'pan',
  'bankAccountNumber',
  'bankIfsc',
  'beneficiaryName',
  'esicNumber',
  'esicIpNumber',
  'uanNumber',
  'dateOfBirth',
  'emergencyContactName',
  'emergencyContactPhone',
]);

const SENSITIVE_PERMISSION = 'PARTY_SENSITIVE_READ';
const MASK_CHAR = '•';
// Fixed width, so the mask does not reveal how long the value is.
const MASK_PREFIX = MASK_CHAR.repeat(8);

// The last four of a date is the birthday ('05-15'), so a date of birth is
// hidden whole rather than "last four".
const KEEP_LAST = { dateOfBirth: 0 };

/** '999900001111' -> '••••••••1111'. null stays null; a value of 4 or fewer characters is hidden whole. */
const maskValue = (value, keep = 4) => {
  if (value === null || value === undefined || value === '') return value;
  const text = String(value);
  if (!keep || text.length <= keep) return MASK_PREFIX;
  return `${MASK_PREFIX}${text.slice(-keep)}`;
};

const isMaskedValue = (value) => typeof value === 'string' && value.includes(MASK_CHAR);

const canViewSensitive = (user) => hasPermission(user, SENSITIVE_PERMISSION);

const maskRecord = (record) => {
  if (!record || typeof record !== 'object') return record;
  const plain = typeof record.toJSON === 'function' ? record.toJSON() : { ...record };
  for (const field of SENSITIVE_FIELDS) {
    if (field in plain) plain[field] = maskValue(plain[field], KEEP_LAST[field] ?? 4);
  }
  return plain;
};

/**
 * Masks a party, an array of parties, or a findAndCountAll `{ rows, count }`
 * payload — unless the user holds PARTY_SENSITIVE_READ. The one place masking
 * happens, so the parties endpoints cannot each get it slightly different.
 */
const maskSensitiveFields = (payload, user) => {
  if (canViewSensitive(user)) return payload;
  if (Array.isArray(payload)) return payload.map(maskRecord);
  if (payload && Array.isArray(payload.rows)) return { ...payload, rows: payload.rows.map(maskRecord) };
  return maskRecord(payload);
};

/**
 * The edit form and an exported-then-reimported workbook both send back the
 * masked value they were given. Writing that would replace a real Aadhaar with
 * bullets, so a sensitive field still carrying the mask means "unchanged" and
 * is dropped before it reaches the model.
 */
const dropMaskedSensitive = (data) => {
  if (!data || typeof data !== 'object') return data;
  const clean = { ...data };
  for (const field of SENSITIVE_FIELDS) {
    if (isMaskedValue(clean[field])) delete clean[field];
  }
  return clean;
};

/**
 * The caller, for code that has no `req` — the master-data export runs a
 * config's `load` with only the query, and the import calls PartiesService
 * without the user, but both run inside the request's CLS session, so the
 * caller is recovered from the audit context's userId. Null outside a request.
 */
const currentActor = async () => {
  const { getUserId } = require('../../core/tenantContext');
  const userId = getUserId();
  if (!userId) return null;
  const { User } = require('../users/user.model');
  const user = await User.findByPk(userId, { attributes: ['id', 'role'] });
  if (!user) return null;
  const { authService } = require('../auth/auth.service');
  const permissions = await authService.getPermissionsForUser(user.id, user.role);
  return { userId: user.id, role: user.role, permissions };
};

const currentUserCanViewSensitive = async () => {
  const actor = await currentActor();
  return actor ? canViewSensitive(actor) : false;
};

module.exports = {
  SENSITIVE_FIELDS,
  SENSITIVE_PERMISSION,
  MASK_CHAR,
  maskValue,
  isMaskedValue,
  canViewSensitive,
  maskSensitiveFields,
  dropMaskedSensitive,
  currentActor,
  currentUserCanViewSensitive,
  KEEP_LAST,
};
