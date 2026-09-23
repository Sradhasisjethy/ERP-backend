const { sequelize } = require('../src/config/database');
const { env } = require('../src/config/env');
const { todayInZone } = require('../src/utils/dateDisplay');

/**
 * Guards the date the database computes "today" as.
 *
 * Sequelize pins every Postgres connection's TimeZone. Left unset it pins it to
 * UTC, overriding the server — `current_setting('TimeZone')` returned
 * `<+00>-00` on a box configured for Asia/Kolkata. CURRENT_DATE appears in ten
 * report expressions (receivables ageing, overdue sales orders, days pending,
 * stock ageing, dead stock value) and the curing promotion compares against
 * NOW(), so under UTC all of them read the previous day between 00:00 and
 * 05:30 IST.
 *
 * The first test below is the one that matters: it fails at any hour of the day
 * if the connection zone is wrong, rather than only during the 5½-hour window
 * when the symptom is visible. That window is exactly why the bug survived —
 * the dashboard equivalent passed all afternoon and failed at 02:39.
 */

const raw = (sql) => sequelize.query(sql, { type: sequelize.QueryTypes.SELECT });

afterAll(async () => {
  await sequelize.close();
});

describe('The zone the database computes dates in', () => {
  it('pins the connection to the configured application timezone', async () => {
    const [row] = await raw("SELECT current_setting('TimeZone') AS tz");
    // Deterministic: true or false regardless of what time the suite runs.
    // Before the fix this read '<+00>-00' at every hour.
    expect(row.tz).toBe(env.APP_TIMEZONE);
  });

  it('agrees with the zone the application formats dates in', async () => {
    const [row] = await raw('SELECT CURRENT_DATE::text AS cd');
    expect(row.cd).toBe(todayInZone(env.APP_TIMEZONE));
  });

  it('does not disagree with NOW() about which day it is', async () => {
    // CURRENT_DATE and NOW() are read by different code paths — reports use the
    // first, curing promotion the second. They must land on the same day.
    const [row] = await raw("SELECT CURRENT_DATE::text AS cd, (NOW())::date::text AS nd");
    expect(row.cd).toBe(row.nd);
  });
});

describe('Why the zone matters', () => {
  it('demonstrates that UTC and the app zone disagree inside the early-morning window', async () => {
    // 02:00 IST on a fixed date: still the previous day in UTC. This is the
    // divergence the reports were exposed to, stated as an assertion rather
    // than left as an argument in a comment.
    const [row] = await raw(`
      SELECT
        (TIMESTAMPTZ '2026-09-11 02:00:00+05:30' AT TIME ZONE 'UTC')::date::text          AS utc_day,
        (TIMESTAMPTZ '2026-09-11 02:00:00+05:30' AT TIME ZONE 'Asia/Kolkata')::date::text AS ist_day
    `);
    expect(row.utc_day).toBe('2026-09-10');
    expect(row.ist_day).toBe('2026-09-11');
    expect(row.utc_day).not.toBe(row.ist_day);
  });

  it('would have mis-aged a document by a full day under UTC', async () => {
    // A receivable dated 2026-09-11, aged at 02:00 IST that same morning:
    // zero days outstanding in the app's zone, but one under UTC — which is how
    // an invoice raised hours earlier appears overdue on the ageing report.
    const [row] = await raw(`
      SELECT
        ((TIMESTAMPTZ '2026-09-11 02:00:00+05:30' AT TIME ZONE 'UTC')::date          - DATE '2026-09-11') AS utc_age,
        ((TIMESTAMPTZ '2026-09-11 02:00:00+05:30' AT TIME ZONE 'Asia/Kolkata')::date - DATE '2026-09-11') AS ist_age
    `);
    expect(Number(row.ist_age)).toBe(0);
    expect(Number(row.utc_age)).toBe(-1);
  });
});

describe('Configuration drift', () => {
  it('keeps the database zone and the tenants\' display zone in step', async () => {
    // Queried raw rather than through SettingsService: that reads through the
    // tenant CLS scope, which does not exist outside a request.
    const rows = await raw(`SELECT DISTINCT value FROM tenant_settings WHERE key = 'timezone'`);
    const configured = rows.map((r) => r.value).filter(Boolean);

    // Nothing to check on an empty database; the invariant only bites once a
    // tenant has chosen a zone.
    if (!configured.length) return;

    for (const zone of configured) {
      // A tenant displaying Asia/Kolkata while the database ages their invoices
      // in another zone is the drift this whole file exists to prevent.
      expect(zone).toBe(env.APP_TIMEZONE);
    }
  });
});
