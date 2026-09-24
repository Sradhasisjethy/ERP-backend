const { SystemRoles } = require('./constants');

/**
 * Kept for the handful of call sites that name their fields explicitly, and so
 * the old export keeps working. It is no longer the default: see below.
 */
const RATE_FIELDS_DEFAULT = ['ratePaise', 'standardCostPaise', 'totalAmountPaise', 'amountPaise'];

/**
 * Every money column in this codebase is an integer number of paise whose name
 * ends in `Paise` — 147 distinct ones across the models, without exception.
 * Matching on that is what lets masking be complete by default instead of by
 * remembering, which is how the four-name list came to be wrong.
 */
const MONEY_FIELD = /Paise$/;

const VIEW_RATES_BYPASS_ROLES = [SystemRoles.PLATFORM_ADMIN, SystemRoles.TENANT_OWNER];

const hasViewRates = (req) => {
  if (VIEW_RATES_BYPASS_ROLES.includes(req.user.role)) return true;
  return (req.user.permissions || []).includes('VIEW_RATES');
};

/**
 * Nulls out rate/amount fields before a response is serialized, per BR-27:
 * "masked at the API response level ... the data never reaches their browser."
 * Hiding the field in the UI is not sufficient — this must run server-side.
 *
 * Accepts a single record, an array of records, or a Sequelize
 * findAndCountAll-style `{ rows, count }` payload.
 *
 * Two things were wrong with the previous implementation, and both leaked the
 * commercial figures BR-07 exists to keep off the shop floor:
 *
 *  1. **It did not recurse.** `strip` cloned the record and nulled top-level
 *     keys only, so every detail endpoint that returns a header *with lines*
 *     masked the header total and returned `lines[].ratePaise` in full. A user
 *     with SALES_READ and no VIEW_RATES simply read the per-unit price off the
 *     order detail screen.
 *  2. **The default field list named four columns** out of 147. A sales invoice
 *     has none of them on its header — its money lives in `subtotalPaise`,
 *     `cgstPaise`, `sgstPaise`, `igstPaise` and `totalPaise` — so the invoice
 *     endpoint masked nothing at all while appearing to be protected.
 *
 * Passing `fields` explicitly still works and still wins, for the call sites
 * that deliberately mask a narrower set.
 *
 * @param {object|Array} payload
 * @param {object} req
 * @param {string[]} [fields] - explicit allow-list; omit to mask every *Paise key
 */
const maskRateFields = (payload, req, fields = null) => {
  if (hasViewRates(req)) return payload;

  const shouldMask = fields
    ? (key) => fields.includes(key)
    : (key) => MONEY_FIELD.test(key);

  // Depth-limited so a cyclic or unexpectedly deep graph cannot hang a request.
  const strip = (value, depth = 0) => {
    if (value === null || value === undefined || depth > 8) return value;
    if (Array.isArray(value)) return value.map((item) => strip(item, depth + 1));
    if (typeof value !== 'object') return value;
    // Dates, Buffers and the like are values, not records to walk into.
    if (value instanceof Date || Buffer.isBuffer(value)) return value;

    const plain = typeof value.toJSON === 'function' ? value.toJSON() : value;
    if (plain === null || typeof plain !== 'object' || Array.isArray(plain)) return strip(plain, depth + 1);

    const clone = {};
    for (const [key, item] of Object.entries(plain)) {
      clone[key] = shouldMask(key) ? null : strip(item, depth + 1);
    }
    return clone;
  };

  if (Array.isArray(payload)) return payload.map((row) => strip(row));
  if (payload && Array.isArray(payload.rows)) return { ...payload, rows: payload.rows.map((row) => strip(row)) };
  return strip(payload);
};

module.exports = { maskRateFields, hasViewRates, RATE_FIELDS_DEFAULT, MONEY_FIELD };
