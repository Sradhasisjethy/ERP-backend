/**
 * Column vocabulary shared by the screen, the Excel export and the PDF export.
 *
 * A report declares its columns once, here, and all three renderers read the
 * same list. That is what stops the three from drifting — the alignment, the
 * number format and the field-level permission are properties of the column,
 * not of whichever renderer happens to be drawing it.
 */

/** Right-aligned types are the numeric ones; everything else reads left. */
const NUMERIC_TYPES = new Set(['money', 'qty', 'int', 'percent']);

const DEFAULT_WIDTH = { text: 24, code: 14, date: 12, status: 16, money: 16, qty: 12, int: 10, percent: 10 };

/**
 * BR-27: money never reaches a browser that may not see rates. Declaring
 * `type: 'money'` therefore implies `requires: 'VIEW_RATES'` automatically —
 * a report author cannot forget it, and the runner strips the key from the
 * payload entirely rather than nulling it (FR-M27-3: a blanked column still
 * tells the reader a number exists).
 */
const column = (key, header, type = 'text', options = {}) => ({
  key,
  header,
  type,
  align: options.align || (NUMERIC_TYPES.has(type) ? 'right' : 'left'),
  sortable: options.sortable !== false,
  hidden: options.hidden === true,
  width: options.width || DEFAULT_WIDTH[type] || 18,
  requires: 'requires' in options ? options.requires : type === 'money' ? 'VIEW_RATES' : null,
  ...(options.total ? { total: options.total } : {}),
  ...(options.description ? { description: options.description } : {}),
});

const text = (key, header, options) => column(key, header, 'text', options);
const code = (key, header, options) => column(key, header, 'code', options);
const date = (key, header, options) => column(key, header, 'date', options);
const qty = (key, header, options) => column(key, header, 'qty', options);
const money = (key, header, options) => column(key, header, 'money', options);
const percent = (key, header, options) => column(key, header, 'percent', options);
const int = (key, header, options) => column(key, header, 'int', options);
const status = (key, header, options) => column(key, header, 'status', { sortable: false, ...options });

/** Summary tile definition — same type vocabulary, so formatting is shared. */
const metric = (key, label, type = 'money', options = {}) => ({
  key,
  label,
  type,
  requires: 'requires' in options ? options.requires : type === 'money' ? 'VIEW_RATES' : null,
});

/**
 * Field-level security, applied server-side (§11/§18): a column the user may
 * not see is removed from the column list AND its key is deleted from every
 * row and summary before serialization. Hiding it in the UI would leave the
 * value sitting in the JSON payload.
 */
/**
 * Delegates to the system's single permission rule rather than re-deriving one.
 *
 * That matters: PLATFORM_ADMIN and TENANT_OWNER carry an *empty* permission
 * list — their access comes from the role-level bypass in
 * middlewares/authorize.js, not from holding codes. Checking
 * `permissions.includes(grant)` here would have stripped every money column
 * from the two roles that are supposed to see everything.
 */
const holdsGrant = (user, grant) => {
  if (!grant) return true;
  const { hasPermission } = require('../../../middlewares/authorize');
  return hasPermission(user, grant);
};

const visibleColumns = (columns, { user, bypassFieldSecurity = false }) =>
  bypassFieldSecurity ? columns : columns.filter((c) => holdsGrant(user, c.requires));

const visibleMetrics = (metrics, { user, bypassFieldSecurity = false }) =>
  bypassFieldSecurity ? metrics : (metrics || []).filter((m) => holdsGrant(user, m.requires));

/** Deletes every key the caller is not allowed to receive from a row object. */
const stripDeniedKeys = (row, deniedKeys) => {
  if (!deniedKeys.size) return row;
  const clone = { ...row };
  for (const key of deniedKeys) delete clone[key];
  return clone;
};

module.exports = {
  column,
  text,
  code,
  date,
  qty,
  money,
  percent,
  int,
  status,
  metric,
  visibleColumns,
  visibleMetrics,
  stripDeniedKeys,
  holdsGrant,
  NUMERIC_TYPES,
};
