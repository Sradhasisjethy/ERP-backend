const { SystemRoles } = require('./constants');

const RATE_FIELDS_DEFAULT = ['ratePaise', 'standardCostPaise', 'totalAmountPaise', 'amountPaise'];

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
 */
const maskRateFields = (payload, req, fields = RATE_FIELDS_DEFAULT) => {
  if (hasViewRates(req)) return payload;

  const strip = (record) => {
    if (!record || typeof record !== 'object') return record;
    const plain = typeof record.toJSON === 'function' ? record.toJSON() : record;
    const clone = { ...plain };
    fields.forEach((f) => {
      if (f in clone) clone[f] = null;
    });
    return clone;
  };

  if (Array.isArray(payload)) return payload.map(strip);
  if (payload && Array.isArray(payload.rows)) return { ...payload, rows: payload.rows.map(strip) };
  return strip(payload);
};

module.exports = { maskRateFields, hasViewRates, RATE_FIELDS_DEFAULT };
