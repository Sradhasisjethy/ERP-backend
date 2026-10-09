/**
 * Presentation settings and value formatting for exports.
 *
 * The organisation's configured currency and date format are honoured where
 * they exist (tenant_settings holds arbitrary key/value pairs); the fallbacks
 * below are this application's actual defaults — integer paise in INR, and the
 * unambiguous dd-MMM-yyyy that avoids the DD/MM vs MM/DD trap on a report
 * someone might read in either convention.
 */

const DEFAULTS = Object.freeze({
  currency: 'INR',
  currencySymbol: '₹',
  locale: 'en-IN',
  decimalPlaces: 2,
});

const SETTING_KEYS = ['reports.currency', 'currency', 'reports.locale', 'locale'];

/**
 * The stored locale if Intl accepts it, else the default. Settings are free
 * JSONB, and one bad row ('en_IN', a number, an object) made every
 * Intl.NumberFormat call throw a RangeError — every export of every report
 * failed until someone found the row. Same stance as dateDisplay.js takes on
 * an unknown timezone: a bad preference must not stop a document rendering.
 */
// formatValue calls this per cell, so answers are remembered; a tenant has one
// locale, so the map stays tiny (and is capped in case it does not).
const checkedLocales = new Map();
const safeLocale = (value) => {
  if (typeof value !== 'string' || !value.trim() || value.length > 35) return DEFAULTS.locale;
  if (checkedLocales.has(value)) return checkedLocales.get(value);
  let resolved = DEFAULTS.locale;
  try {
    const [canonical] = Intl.getCanonicalLocales(value.trim());
    // Also constructed, because getCanonicalLocales accepts some tags that
    // NumberFormat still refuses.
    new Intl.NumberFormat(canonical);
    resolved = canonical || DEFAULTS.locale;
  } catch {
    resolved = DEFAULTS.locale;
  }
  if (checkedLocales.size < 100) checkedLocales.set(value, resolved);
  return resolved;
};

/** An ISO 4217 code Intl knows, else the default — it is printed in every header. */
const safeCurrency = (value) => {
  if (typeof value !== 'string' || !/^[A-Z]{3}$/.test(value.trim())) return DEFAULTS.currency;
  try {
    new Intl.NumberFormat('en', { style: 'currency', currency: value.trim() });
    return value.trim();
  } catch {
    return DEFAULTS.currency;
  }
};

/** One lookup per export, not per cell. */
const resolveFormatSettings = async () => {
  // Required here, not at the top: the export worker threads load this file
  // for the pure formatters and must not drag the database in with it.
  const { TenantSettings } = require('../../settings/settings.model');
  const rows = await TenantSettings.findAll({ where: { key: SETTING_KEYS.map((k) => k) } }).catch(() => []);
  const byKey = new Map(rows.map((r) => [r.key, r.value]));
  const read = (...keys) => {
    for (const key of keys) {
      const value = byKey.get(key);
      if (value === undefined || value === null) continue;
      return typeof value === 'object' ? value.value ?? null : value;
    }
    return null;
  };

  const currency = safeCurrency(read('reports.currency', 'currency'));
  const locale = safeLocale(read('reports.locale', 'locale'));
  return { ...DEFAULTS, currency, locale };
};

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const formatDate = (value) => {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return `${String(date.getUTCDate()).padStart(2, '0')}-${MONTHS[date.getUTCMonth()]}-${date.getUTCFullYear()}`;
};

const formatDateTime = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  const hours = String(date.getUTCHours()).padStart(2, '0');
  const minutes = String(date.getUTCMinutes()).padStart(2, '0');
  return `${formatDate(date)} ${hours}:${minutes} UTC`;
};

/** A status/enum token as a human would write it: PARTIALLY_PAID -> Partially Paid. */
const humanise = (value) =>
  String(value ?? '')
    .toLowerCase()
    .split(/[\s_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');

/**
 * Plain-text rendering used by CSV and PDF.
 *
 * Money is rendered as a grouped number with no currency symbol. That is a
 * deliberate choice for the PDF: PDFKit's built-in fonts are WinAnsi-encoded
 * and have no glyph for ₹, so a symbol would come out as a wrong character or
 * a blank box. The header carries "All amounts in <currency>" instead, and the
 * Excel export — where Unicode is not a problem — uses a real currency format.
 */
const formatValue = (value, column, settings = DEFAULTS) => {
  if (value === null || value === undefined || value === '') return '';
  // Re-checked here: the worker threads receive settings by structured clone,
  // and a caller could build them without resolveFormatSettings.
  const { decimalPlaces } = settings;
  const locale = safeLocale(settings.locale);

  switch (column.type) {
    case 'money':
      return new Intl.NumberFormat(locale, {
        minimumFractionDigits: decimalPlaces,
        maximumFractionDigits: decimalPlaces,
      }).format(Number(value) / 100);
    case 'qty':
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 4 }).format(Number(value));
    case 'int':
      return new Intl.NumberFormat(locale, { maximumFractionDigits: 0 }).format(Number(value));
    case 'percent':
      return `${new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value))}%`;
    case 'date':
      return formatDate(value);
    case 'status':
      return humanise(value);
    default:
      return String(value);
  }
};

/** Excel number formats, so the cell holds a real number the reader can re-total. */
const excelNumberFormat = (type, settings = DEFAULTS) => {
  switch (type) {
    case 'money':
      // Indian digit grouping (##,##,##0) rather than the western ###,###,###.
      return `"${settings.currencySymbol}"##,##,##0.${'0'.repeat(settings.decimalPlaces)}`;
    case 'qty':
      return '##,##,##0.####';
    case 'int':
      return '##,##,##0';
    case 'percent':
      return '0.00"%"';
    case 'date':
      return 'dd-mmm-yyyy';
    default:
      return null;
  }
};

/** The value Excel should store: a number for numeric types, text otherwise. */
const excelValue = (value, column) => {
  if (value === null || value === undefined || value === '') return null;
  switch (column.type) {
    case 'money':
      return Number(value) / 100;
    case 'qty':
    case 'int':
    case 'percent':
      return Number(value);
    case 'date': {
      const date = value instanceof Date ? value : new Date(value);
      return Number.isNaN(date.getTime()) ? String(value) : date;
    }
    case 'status':
      return humanise(value);
    default:
      return String(value);
  }
};

module.exports = { DEFAULTS, safeLocale, safeCurrency, resolveFormatSettings, formatValue, formatDate, formatDateTime, humanise, excelNumberFormat, excelValue };
