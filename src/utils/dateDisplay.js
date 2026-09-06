/**
 * Renders a date the way the tenant asked for it in Settings > General.
 *
 * The setting existed and was saved, but nothing read it: printed documents
 * showed the raw column value, so a challan dated 4 September printed
 * "2026-09-04" on a tenant configured for DD/MM/YYYY.
 *
 * Deliberately not Intl.DateTimeFormat. The stored patterns are explicit about
 * digit order, Intl's are locale-derived, and picking a locale that happens to
 * produce DD/MM/YYYY would mean a later locale change silently reordering
 * dates on filed documents. These three patterns are the whole vocabulary the
 * settings screen offers, so they are implemented literally.
 */

const PATTERNS = {
  'DD/MM/YYYY': ({ dd, mm, yyyy }) => `${dd}/${mm}/${yyyy}`,
  'MM/DD/YYYY': ({ dd, mm, yyyy }) => `${mm}/${dd}/${yyyy}`,
  'YYYY-MM-DD': ({ dd, mm, yyyy }) => `${yyyy}-${mm}-${dd}`,
};

const DEFAULT_PATTERN = 'DD/MM/YYYY';

/**
 * Splits a value into calendar parts in the tenant's timezone.
 *
 * A DATEONLY column arrives as "2026-09-04" and is already the calendar date
 * that was meant — parsing it into a Date and reading it back in another
 * timezone can move it a day, which on a dispatch date is a different business
 * day and on an invoice a different GST return period. So a plain date string
 * is taken apart textually and never goes near a timezone at all. Timestamps,
 * which really do denote an instant, are converted.
 */
const partsOf = (value, timeZone) => {
  if (value === null || value === undefined || value === '') return null;

  const plainDate = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value));
  if (plainDate) {
    const [, yyyy, mm, dd] = plainDate;
    return { yyyy, mm, dd };
  }

  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  if (timeZone) {
    try {
      const formatted = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(date);
      const [yyyy, mm, dd] = formatted.split('-');
      return { yyyy, mm, dd };
    } catch {
      // An unknown timezone must not stop a document printing.
    }
  }

  return {
    yyyy: String(date.getUTCFullYear()),
    mm: String(date.getUTCMonth() + 1).padStart(2, '0'),
    dd: String(date.getUTCDate()).padStart(2, '0'),
  };
};

/**
 * @param value      a Date, an ISO timestamp, or a "YYYY-MM-DD" DATEONLY string
 * @param dateFormat one of the patterns above; anything else falls back
 * @param timeZone   IANA zone, used only for real timestamps
 * @returns the formatted date, or '' for a value that is not a date
 */
const formatDate = (value, { dateFormat, timeZone } = {}) => {
  const parts = partsOf(value, timeZone);
  if (!parts) return '';
  const render = PATTERNS[dateFormat] || PATTERNS[DEFAULT_PATTERN];
  return render(parts);
};

/**
 * "Today" and "the first of this month", as calendar dates in the tenant's
 * timezone, formatted YYYY-MM-DD for comparison against DATEONLY columns.
 *
 * The dashboard used `new Date().toISOString().slice(0, 10)`, which is the UTC
 * date: at UTC+05:30 that is yesterday until 05:30 local, so a run recorded at
 * 01:00 was not counted as produced today. Month-to-date had the mirror-image
 * fault — `new Date(y, m, 1).toISOString()` builds local midnight and then
 * reads it back in UTC, landing on the last day of the previous month.
 */
const todayInZone = (timeZone) => {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: timeZone || undefined,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
};

/** First day of the month `todayInZone` falls in — no date arithmetic round trip. */
const monthStartInZone = (timeZone) => `${todayInZone(timeZone).slice(0, 7)}-01`;

module.exports = { formatDate, todayInZone, monthStartInZone, PATTERNS, DEFAULT_PATTERN };
