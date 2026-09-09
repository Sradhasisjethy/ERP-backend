const { BundleRulesService } = require('../src/api/bundles/bundleRules.service');

/**
 * Archiving used to stamp the UTC date of the day it was clicked, whatever else
 * had happened to the lineage. BND-RCC-600 v1 ended up recorded as in force
 * 04 Sep -> 05 Sep while v2 held the 4th and v3 the 5th — three versions of one
 * bundle claiming the same days, which makes "which accessories apply on this
 * order" unanswerable.
 *
 * _dayBefore is the handover point the close date is clamped to, so it is
 * pinned here directly; the clamping itself needs a database and is covered by
 * the module's own suite once that can run.
 */
describe('bundle version handover', () => {
  it('hands over the day before the next version starts', () => {
    expect(BundleRulesService._dayBefore('2026-09-05')).toBe('2026-09-04');
  });

  it('crosses a month boundary', () => {
    expect(BundleRulesService._dayBefore('2026-10-01')).toBe('2026-09-30');
  });

  it('crosses a year boundary', () => {
    expect(BundleRulesService._dayBefore('2027-01-01')).toBe('2026-12-31');
  });

  it('handles a leap day', () => {
    // 2028 is a leap year — the day before 1 March is the 29th, not the 28th.
    expect(BundleRulesService._dayBefore('2028-03-01')).toBe('2028-02-29');
  });

  it('is stable regardless of the machine timezone', () => {
    // The date arithmetic must not shift because the server sits east or west
    // of UTC — that is the class of bug this fix exists to close.
    const original = process.env.TZ;
    try {
      process.env.TZ = 'Asia/Kolkata';
      expect(BundleRulesService._dayBefore('2026-09-05')).toBe('2026-09-04');
      process.env.TZ = 'Pacific/Kiritimati';
      expect(BundleRulesService._dayBefore('2026-09-05')).toBe('2026-09-04');
    } finally {
      process.env.TZ = original;
    }
  });
});
