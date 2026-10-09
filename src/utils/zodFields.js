const { z } = require('zod');

/**
 * Field types shared by the request schemas.
 *
 * Business dates used to be `z.string()` in most modules and a bare
 * /^\d{4}-\d{2}-\d{2}$/ in five others. Either way '2024-02-30' and
 * '2025-04-01T00:00:00+14:00' got through, and Postgres or `new Date()` then
 * decided what they meant — a rolled-over day, or the previous day in UTC,
 * which is how a document lands in a closed period. One strict definition,
 * used everywhere, means a date is either a real calendar day or a 400.
 */

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True only for a real calendar day written as YYYY-MM-DD. */
const isIsoDate = (value) => {
  if (typeof value !== 'string' || !ISO_DATE_PATTERN.test(value)) return false;
  // JS has a year 0; Postgres does not, and would answer it with a 500.
  if (value.startsWith('0000')) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  // The round trip is what rejects 2024-02-30: Date rolls it into March.
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};

const DATE_MESSAGE = 'must be a date in YYYY-MM-DD format';

// superRefine rather than refine so the message names the field — the client
// shows the joined messages as-is, and "must be a date" alone says nothing.
const isoDate = z.string().superRefine((value, ctx) => {
  if (isIsoDate(value)) return;
  const field = ctx.path.length ? ctx.path[ctx.path.length - 1] : null;
  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message: typeof field === 'string' ? `${field} ${DATE_MESSAGE}` : DATE_MESSAGE,
  });
});
const optionalIsoDate = isoDate.optional();
const nullableIsoDate = isoDate.nullable().optional();

// Caps. Strings stop at the column they are stored in (VARCHAR(255) unless the
// model says otherwise), free text at 5000, search boxes at 200. Arrays of
// document lines stop at 500 — far above any real document, far below what
// would tie up a connection for minutes. Paise stays a safe integer so it
// survives the trip through JS arithmetic and BIGINT intact.
const MAX_STRING = 255;
const MAX_TEXT = 5000;
const MAX_SEARCH = 200;
const MAX_LINES = 500;
const MAX_IDS = 200;
const MAX_QTY = 1e9;
const MAX_PAISE = Number.MAX_SAFE_INTEGER;

const text = (max = MAX_STRING) => z.string().max(max);
const longText = (max = MAX_TEXT) => z.string().max(max);
const searchText = z.string().trim().min(1).max(MAX_SEARCH);

/** Whole paise, never negative. Each field keeps its own floor on top of this. */
const paise = z.coerce.number().finite().int().min(0).max(MAX_PAISE);
/** A quantity: finite and positive, with a ceiling no plant reaches. */
const qty = z.coerce.number().finite().positive().max(MAX_QTY);

module.exports = {
  ISO_DATE_PATTERN,
  isIsoDate,
  isoDate,
  optionalIsoDate,
  nullableIsoDate,
  MAX_STRING,
  MAX_TEXT,
  MAX_SEARCH,
  MAX_LINES,
  MAX_IDS,
  MAX_QTY,
  MAX_PAISE,
  text,
  longText,
  searchText,
  paise,
  qty,
};
