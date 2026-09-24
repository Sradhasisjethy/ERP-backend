/**
 * What a spreadsheet cell means, and what it is allowed to contain.
 *
 * One column definition drives four things that would otherwise drift apart:
 * the sample workbook header and example, the Instructions sheet rule text, the
 * export cell, and the import coercion and validation. A template that
 * disagrees with the importer is worse than no template at all — the user fills
 * it in correctly and is told they are wrong — so there is exactly one list.
 *
 * Every coercion returns `{ value }` or `{ error }`. Never a throw: one bad
 * cell must not stop the other 4,999 rows from being checked, because the point
 * of the preview is to show the user every problem at once.
 */

const { toPaise } = require('../../utils/money');

const isBlank = (value) => value === undefined || value === null || String(value).trim() === '';

/**
 * ExcelJS hands back rich text, hyperlinks and formula results as objects
 * rather than strings. Flatten them before anything else looks at the value.
 */
const cellText = (raw) => {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Date) return raw.toISOString().slice(0, 10);
  if (typeof raw === 'object') {
    if (Array.isArray(raw.richText)) return raw.richText.map((part) => part.text).join('');
    if (raw.text !== undefined) return String(raw.text);
    if (raw.result !== undefined) return String(raw.result);
    if (raw.hyperlink !== undefined) return String(raw.hyperlink);
    return '';
  }
  return String(raw);
};

/** DD/MM/YYYY (what the templates ask for) or YYYY-MM-DD, plus a real date cell. */
const parseDate = (raw) => {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw.toISOString().slice(0, 10);
  const text = cellText(raw).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const dmy = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(text);
  if (dmy) {
    const [, d, m, y] = dmy;
    return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  }
  return null;
};

const isRealDate = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
};

const TRUTHY = new Set(['yes', 'y', 'true', '1', 'active']);
const FALSY = new Set(['no', 'n', 'false', '0', 'inactive']);

/**
 * Turns one cell into the value the business service expects.
 *
 * @param {object} column - the column definition
 * @param {*} raw - whatever ExcelJS produced for the cell
 * @param {object} lookups - { [master]: Map<upperCasedKey, id> } for reference columns
 */
const coerce = (column, raw, lookups = {}) => {
  const text = cellText(raw).trim();

  if (isBlank(text)) {
    if (column.required) return { error: `${column.header} is required` };
    // A cleared cell on an update means "set this back to empty", which is a
    // different instruction from "leave it alone". Columns that cannot express
    // the difference (a reference, a status) are skipped when blank instead.
    return { value: column.blankIsNull ? null : undefined };
  }

  switch (column.type) {
    case 'text':
    case 'code': {
      const value = column.type === 'code' && column.upperCase !== false ? text.toUpperCase() : text;
      if (column.maxLength && value.length > column.maxLength) {
        return { error: `${column.header} is longer than ${column.maxLength} characters` };
      }
      if (column.pattern && !column.pattern.test(value)) {
        return { error: column.patternMessage || `${column.header} is not in the expected format` };
      }
      return { value };
    }

    case 'email': {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) return { error: `${column.header} is not a valid email address` };
      return { value: text.toLowerCase() };
    }

    case 'integer':
    case 'number': {
      const num = Number(text.replace(/[,\s]/g, ''));
      if (!Number.isFinite(num)) return { error: `${column.header} must be a number` };
      if (column.type === 'integer' && !Number.isInteger(num)) {
        return { error: `${column.header} must be a whole number` };
      }
      if (column.min !== undefined && num < column.min) return { error: `${column.header} cannot be less than ${column.min}` };
      if (column.max !== undefined && num > column.max) return { error: `${column.header} cannot be more than ${column.max}` };
      return { value: num };
    }

    case 'money': {
      // Written in rupees because that is what a human types; stored in paise.
      const num = Number(text.replace(/[₹,\s]/g, ''));
      if (!Number.isFinite(num)) return { error: `${column.header} must be an amount in rupees, for example 4500.00` };
      if (num < 0 && !column.allowNegative) return { error: `${column.header} cannot be negative` };
      return { value: toPaise(num) };
    }

    case 'boolean': {
      const lower = text.toLowerCase();
      if (TRUTHY.has(lower)) return { value: true };
      if (FALSY.has(lower)) return { value: false };
      return { error: `${column.header} must be Yes or No` };
    }

    case 'date': {
      const iso = parseDate(raw);
      if (!iso || !isRealDate(iso)) return { error: `${column.header} must be a date as DD/MM/YYYY, for example 01/04/2026` };
      return { value: iso };
    }

    case 'enum': {
      const match = (column.values || []).find((v) => String(v).toLowerCase() === text.toLowerCase());
      if (!match) return { error: `${column.header} must be one of: ${(column.values || []).join(', ')}` };
      return { value: column.enumMap ? column.enumMap[match] : match };
    }

    case 'reference': {
      const table = lookups[column.reference.master];
      const id = table ? table.get(String(text).trim().toUpperCase()) : undefined;
      if (!id) return { error: `${column.header} "${text}" does not exist in ${column.reference.label}` };
      return { value: id };
    }

    default:
      return { value: text };
  }
};

/** How a stored record value is written back into a spreadsheet cell. */
const present = (column, record, names = {}) => {
  const value = column.exportValue ? column.exportValue(record, names) : record[column.field];
  if (value === null || value === undefined) return null;

  switch (column.type) {
    case 'money':
      return Number(value) / 100;
    case 'number':
    case 'integer':
      return Number(value);
    case 'boolean':
      return value ? 'Yes' : 'No';
    case 'date':
      return String(value).slice(0, 10);
    case 'enum': {
      if (!column.enumMap) return value;
      return Object.keys(column.enumMap).find((key) => column.enumMap[key] === value) || value;
    }
    default:
      return value;
  }
};

/** The Excel number format a column cells should carry, if any. */
const numberFormat = (column) => {
  if (column.type === 'money') return '#,##0.00';
  if (column.type === 'number') return '#,##0.####';
  if (column.type === 'integer') return '#,##0';
  return null;
};

/** The plain-English rule shown on the Instructions sheet. */
const ruleText = (column) => {
  const parts = [column.required ? 'Required' : 'Optional'];
  if (column.readOnly) parts.push('do not edit — used to match the existing record');
  if (column.type === 'money') parts.push('amount in rupees, for example 4500.00');
  if (column.type === 'date') parts.push('date as DD/MM/YYYY');
  if (column.type === 'boolean') parts.push('Yes or No');
  if (column.type === 'enum') parts.push(`one of: ${(column.values || []).join(', ')}`);
  if (column.type === 'reference') parts.push(`must already exist in ${column.reference.label}`);
  if (column.maxLength) parts.push(`at most ${column.maxLength} characters`);
  if (column.min !== undefined) parts.push(`at least ${column.min}`);
  if (column.note) parts.push(column.note);
  return parts.join('; ');
};

module.exports = { isBlank, cellText, coerce, present, numberFormat, ruleText, parseDate };
