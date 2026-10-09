const winston = require('winston');

/**
 * Redaction for structured log entries.
 *
 * The first version only looked inside `info.message` when it was an object,
 * but every call site logs `{ message: '<text>', ...fields }`, so it never ran;
 * and its key list missed Aadhaar, PAN, bank details, tokens and headers. This
 * walks every field of the entry, on a copy (a caller's object must not come
 * back with '***REDACTED***' in it), and matches key names case-insensitively.
 *
 * Free text inside `message` is not parsed — what goes into a message string is
 * the call site's responsibility; structured fields are where data belongs.
 */
const REDACTED = '***REDACTED***';

// Substrings: any key containing one of these is redacted outright.
const SECRET_KEY_PARTS = [
  'password', 'passwd', 'secret', 'token', 'authorization', 'cookie', 'otp',
  'aadhaar', 'bankaccount', 'accountnumber', 'ifsc', 'salary', 'ssn', 'dateofbirth',
];
// Whole-key matches, for names that would catch innocent keys as substrings
// ('pan' is in 'company', 'uan' is in 'quantity').
const SECRET_KEYS = new Set(['pan', 'dob', 'uan', 'uannumber', 'esic', 'esicnumber']);

const isSecretKey = (key) => {
  const k = String(key).toLowerCase().replace(/[^a-z]/g, '');
  return SECRET_KEYS.has(k) || SECRET_KEY_PARTS.some((part) => k.includes(part));
};

/** Keeps the first character and the domain: enough to trace, not to harvest. */
const maskEmail = (value) =>
  typeof value === 'string' ? value.replace(/^(.)[^@]*(@.+)$/, '$1***$2') : value;

const redactValue = (value, key, depth) => {
  if (key !== undefined && isSecretKey(key)) return REDACTED;
  if (key !== undefined && /email/i.test(String(key))) return maskEmail(value);
  if (value === null || typeof value !== 'object' || depth > 6) return value;
  if (value instanceof Date) return value;
  if (value instanceof Error) return { name: value.name, message: value.message };
  if (Array.isArray(value)) return value.map((item) => redactValue(item, undefined, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) out[k] = redactValue(v, k, depth + 1);
  return out;
};

const redactPii = winston.format((info) => {
  // Own enumerable string keys only: winston's level/message symbols are left
  // exactly as they are.
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'timestamp') continue;
    info[key] = redactValue(info[key], key === 'message' ? undefined : key, 0);
  }
  return info;
});

const logger = winston.createLogger({
  level: 'info',
  format: winston.format.combine(redactPii(), winston.format.timestamp(), winston.format.json()),
  transports: [new winston.transports.Console()],
});

module.exports = { logger, redactValue, isSecretKey };
