const { TenantSettings } = require('../../settings/settings.model');

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

/** One lookup per export, not per cell. */
const resolveFormatSettings = async () => {
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

  const currency = read('reports.currency', 'currency') || DEFAULTS.currency;
  const locale = read('reports.locale', 'locale') || DEFAULTS.locale;
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
  const { locale, decimalPlaces } = settings;

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

module.exports = { DEFAULTS, resolveFormatSettings, formatValue, formatDate, formatDateTime, humanise, excelNumberFormat, excelValue };
