const { formatDate, todayInZone, monthStartInZone } = require('../src/utils/dateDisplay');

/**
 * Settings > General offers a date format, and until now nothing read it —
 * printed documents showed the raw column value, so a tenant set to DD/MM/YYYY
 * still got "2026-09-04" on a challan.
 */
describe('formatDate', () => {
  it('renders each pattern the settings screen offers', () => {
    expect(formatDate('2026-09-04', { dateFormat: 'DD/MM/YYYY' })).toBe('04/09/2026');
    expect(formatDate('2026-09-04', { dateFormat: 'MM/DD/YYYY' })).toBe('09/04/2026');
    expect(formatDate('2026-09-04', { dateFormat: 'YYYY-MM-DD' })).toBe('2026-09-04');
  });

  it('falls back rather than failing when the tenant has set nothing', () => {
    // A document must print even for a tenant that never opened Settings.
    expect(formatDate('2026-09-04')).toBe('04/09/2026');
    expect(formatDate('2026-09-04', { dateFormat: 'nonsense' })).toBe('04/09/2026');
  });

  it('never moves a plain calendar date across a timezone', () => {
    // A DATEONLY column is already the date that was meant. Parsing it into an
    // instant and reading it back elsewhere can shift it a day — which on a
    // dispatch date is a different business day, and on an invoice a different
    // GST return period.
    for (const timeZone of ['Asia/Kolkata', 'America/New_York', 'Pacific/Kiritimati', 'Etc/GMT+12']) {
      expect(formatDate('2026-09-04', { dateFormat: 'DD/MM/YYYY', timeZone })).toBe('04/09/2026');
    }
  });

  it('converts a real timestamp into the tenant timezone', () => {
    // 2026-09-04T20:00:00Z is already the 5th in Kolkata (+05:30).
    const instant = '2026-09-04T20:00:00.000Z';
    expect(formatDate(instant, { dateFormat: 'DD/MM/YYYY', timeZone: 'Asia/Kolkata' })).toBe('05/09/2026');
    expect(formatDate(instant, { dateFormat: 'DD/MM/YYYY', timeZone: 'America/New_York' })).toBe('04/09/2026');
  });

  it('accepts a Date instance, which is what Sequelize hands back', () => {
    expect(formatDate(new Date('2026-09-04T10:00:00.000Z'), { dateFormat: 'DD/MM/YYYY' })).toBe('04/09/2026');
  });

  it('returns empty for anything that is not a date', () => {
    // Optional dates are common — an unprinted row is right, "Invalid Date" is not.
    for (const value of [null, undefined, '', 'not a date']) {
      expect(formatDate(value, { dateFormat: 'DD/MM/YYYY' })).toBe('');
    }
  });

  it('falls back to UTC on an unknown timezone instead of throwing', () => {
    // A bad setting must not stop a document printing.
    expect(formatDate('2026-09-04T10:00:00.000Z', { dateFormat: 'DD/MM/YYYY', timeZone: 'Mars/Olympus' }))
      .toBe('04/09/2026');
  });
});

/**
 * The dashboard reported "produced 0 today" for a plant that had recorded three
 * runs, because "today" was the UTC date: at UTC+05:30 that is yesterday until
 * 05:30 local, and the entry forms defaulted the same way, so a run keyed at
 * 01:00 was filed to the previous day and then not counted.
 */
describe('calendar boundaries', () => {
  it('gives the calendar date in the tenant timezone, not UTC', () => {
    const kolkata = todayInZone('Asia/Kolkata');
    const utc = new Date().toISOString().slice(0, 10);
    expect(kolkata).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Both are valid dates; they differ during the 00:00-05:30 IST window that
    // caused the bug. Assert the zone is actually consulted rather than that
    // they differ, which depends on when the suite runs.
    const expected = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    expect(kolkata).toBe(expected);
    expect(todayInZone('Pacific/Kiritimati')).not.toBe(todayInZone('Etc/GMT+12'));
    expect(utc).toBe(todayInZone('UTC'));
  });

  it('starts the month on the first, in the tenant timezone', () => {
    // The old helper built local midnight and read it back in UTC, so at
    // UTC+05:30 month-to-date began on the last day of the previous month.
    const start = monthStartInZone('Asia/Kolkata');
    expect(start).toBe(`${todayInZone('Asia/Kolkata').slice(0, 7)}-01`);
    expect(start.endsWith('-01')).toBe(true);
  });

  it('falls back to UTC on an unknown timezone rather than throwing', () => {
    expect(todayInZone('Mars/Olympus')).toBe(new Date().toISOString().slice(0, 10));
  });
});
