const { defineReport } = require('../lib/registry');
const { text, code, date, qty, money, int, status, metric } = require('../lib/columns');

/**
 * Labour attendance and wages.
 *
 * The wage figure reported is `wageAccruedPaise` — what the attendance posting
 * actually credited to the labourer's payable account (workforce.service.js) —
 * not the daily wage multiplied by days present. Recomputing it here would
 * produce a number that disagrees with the books the moment a wage profile is
 * edited, since the accrual is snapshotted at the time attendance is marked.
 *
 * The daily wage column shows the currently effective profile, which is
 * genuinely a different thing (what they would earn today), and is labelled so.
 */

/** The wage profile in force, newest effective-from first. */
const WAGE_PROFILE = `
  LEFT JOIN LATERAL (
    SELECT lwp."dailyWagePaise", lwp."overtimeRateMultiplier"
    FROM labour_wage_profiles lwp
    WHERE lwp."partyId" = pt.id
    ORDER BY lwp."effectiveFrom" DESC NULLS LAST
    LIMIT 1
  ) wage ON TRUE`;

defineReport({
  id: 'labour-attendance',
  category: 'labour',
  slug: 'attendance',
  name: 'Labour Attendance',
  description: 'Day-by-day attendance with the wage accrued for each day marked.',
  dateFieldLabel: 'Attendance Date',
  partyTypeScope: 'LABOUR',
  filters: ['dateFrom', 'dateTo', 'factoryId', 'labourId', 'attendanceStatus'],
  searchFields: ['Labour Name', 'Labour Code'],
  defaultSort: { by: 'attendanceDate', dir: 'desc' },
  columns: [
    code('labourCode', 'Labour Code'),
    text('labourName', 'Labour'),
    date('attendanceDate', 'Date'),
    text('factoryName', 'Location'),
    status('attendanceStatus', 'Attendance'),
    qty('overtimeHours', 'Overtime Hours'),
    money('dailyWagePaise', 'Daily Wage (current)'),
    money('wageAccruedPaise', 'Wage Accrued', { total: true }),
  ],
  summary: [
    metric('recordCount', 'Records', 'int'),
    metric('labourCount', 'Labourers', 'int'),
    metric('presentDays', 'Present Days', 'int'),
    metric('absentDays', 'Absent Days', 'int'),
    metric('overtimeHours', 'Overtime Hours', 'qty'),
    metric('wageAccruedPaise', 'Wage Accrued'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('ar."tenantId"');
    where.factoryScope('ar."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('ar."attendanceDate"', p.dateFrom, p.dateTo);
    where.eq('ar."labourPartyId"', p.labourId);
    where.token('ar."status"', p.attendanceStatus);
    where.search(['pt."name"', 'pt."code"'], p.search);

    return {
      from: `
        attendance_records ar
        JOIN parties pt ON pt.id = ar."labourPartyId"
        JOIN factories f ON f.id = ar."factoryId"
        ${WAGE_PROFILE}`,
      select: `
        ar.id AS "id",
        pt."code" AS "labourCode", pt."name" AS "labourName",
        ar."attendanceDate",
        f."name" AS "factoryName",
        ar."status" AS "attendanceStatus",
        COALESCE(ar."overtimeHours", 0) AS "overtimeHours",
        wage."dailyWagePaise",
        ar."wageAccruedPaise"`,
      where,
      tieBreak: 'ar.id',
      sortMap: {
        labourCode: 'pt."code"',
        labourName: 'pt."name"',
        attendanceDate: 'ar."attendanceDate"',
        factoryName: 'f."name"',
        overtimeHours: 'COALESCE(ar."overtimeHours", 0)',
        dailyWagePaise: 'wage."dailyWagePaise"',
        wageAccruedPaise: 'ar."wageAccruedPaise"',
      },
      summarySelect: `
        COUNT(*)::int AS "recordCount",
        COUNT(DISTINCT ar."labourPartyId")::int AS "labourCount",
        COUNT(*) FILTER (WHERE ar."status" IN ('PRESENT', 'OVERTIME'))::int AS "presentDays",
        COUNT(*) FILTER (WHERE ar."status" = 'ABSENT')::int AS "absentDays",
        COALESCE(SUM(ar."overtimeHours"), 0) AS "overtimeHours",
        COALESCE(SUM(ar."wageAccruedPaise"), 0) AS "wageAccruedPaise"`,
    };
  },
});

defineReport({
  id: 'labour-wages',
  category: 'labour',
  slug: 'wages',
  name: 'Labour Wage Report',
  description: 'Days worked and wages accrued per labourer, against what has been paid out.',
  dateFieldLabel: 'Attendance Date',
  partyTypeScope: 'LABOUR',
  limitations: [
    'Paid and Outstanding are lifetime figures from the labourer\'s payable account: wage payments and advances are not ' +
      'allocated to specific attendance days, so they cannot be confined to the selected date range the way accrual can.',
  ],
  filters: ['dateFrom', 'dateTo', 'factoryId', 'labourId'],
  searchFields: ['Labour Name', 'Labour Code'],
  defaultSort: { by: 'grossWagePaise', dir: 'desc' },
  columns: [
    code('labourCode', 'Labour Code'),
    text('labourName', 'Labour'),
    int('presentDays', 'Days Present'),
    int('halfDays', 'Half Days'),
    int('absentDays', 'Days Absent'),
    int('overtimeDays', 'Overtime Days'),
    qty('overtimeHours', 'Overtime Hours'),
    money('dailyWagePaise', 'Daily Wage (current)'),
    money('grossWagePaise', 'Gross Wage', { total: true }),
    money('paidPaise', 'Paid', { total: true }),
    money('outstandingPaise', 'Outstanding', { total: true }),
  ],
  summary: [
    metric('labourCount', 'Labourers', 'int'),
    metric('presentDays', 'Present Days', 'int'),
    metric('grossWagePaise', 'Gross Wage'),
    metric('paidPaise', 'Paid'),
    metric('outstandingPaise', 'Outstanding'),
  ],
  build({ params: p, allowedFactoryIds, where: openWhere }) {
    const where = openWhere('ar."tenantId"');
    where.factoryScope('ar."factoryId"', allowedFactoryIds, p.factoryId);
    where.dateRange('ar."attendanceDate"', p.dateFrom, p.dateTo);
    where.eq('ar."labourPartyId"', p.labourId);
    where.search(['pt."name"', 'pt."code"'], p.search);

    return {
      from: `
        attendance_records ar
        JOIN parties pt ON pt.id = ar."labourPartyId"
        ${WAGE_PROFILE}
        LEFT JOIN LATERAL (
          SELECT
            COALESCE(SUM(jl."debitPaise"), 0) AS "paidPaise",
            COALESCE(SUM(jl."creditPaise"), 0) AS "earnedPaise"
          FROM journal_lines jl WHERE jl."partyId" = pt.id
        ) bal ON TRUE`,
      select: `
        pt.id AS "id",
        pt."code" AS "labourCode", pt."name" AS "labourName",
        COUNT(*) FILTER (WHERE ar."status" IN ('PRESENT', 'OVERTIME'))::int AS "presentDays",
        COUNT(*) FILTER (WHERE ar."status" = 'HALF_DAY')::int AS "halfDays",
        COUNT(*) FILTER (WHERE ar."status" = 'ABSENT')::int AS "absentDays",
        COUNT(*) FILTER (WHERE ar."status" = 'OVERTIME')::int AS "overtimeDays",
        COALESCE(SUM(ar."overtimeHours"), 0) AS "overtimeHours",
        MAX(wage."dailyWagePaise") AS "dailyWagePaise",
        COALESCE(SUM(ar."wageAccruedPaise"), 0) AS "grossWagePaise",
        MAX(bal."paidPaise") AS "paidPaise",
        GREATEST(MAX(bal."earnedPaise") - MAX(bal."paidPaise"), 0) AS "outstandingPaise"`,
      where,
      groupBy: 'pt.id, pt."code", pt."name"',
      tieBreak: 'pt."name"',
      sortMap: {
        labourCode: 'pt."code"',
        labourName: 'pt."name"',
        presentDays: `COUNT(*) FILTER (WHERE ar."status" IN ('PRESENT', 'OVERTIME'))`,
        absentDays: `COUNT(*) FILTER (WHERE ar."status" = 'ABSENT')`,
        overtimeHours: 'COALESCE(SUM(ar."overtimeHours"), 0)',
        grossWagePaise: 'COALESCE(SUM(ar."wageAccruedPaise"), 0)',
        paidPaise: 'MAX(bal."paidPaise")',
        outstandingPaise: 'GREATEST(MAX(bal."earnedPaise") - MAX(bal."paidPaise"), 0)',
      },
      summaryGroupBy: true,
      summarySelect: `
        COUNT(*)::int AS "labourCount",
        COALESCE(SUM(_s."presentDays"), 0)::int AS "presentDays",
        COALESCE(SUM(_s."grossWagePaise"), 0) AS "grossWagePaise",
        COALESCE(SUM(_s."paidPaise"), 0) AS "paidPaise",
        COALESCE(SUM(_s."outstandingPaise"), 0) AS "outstandingPaise"`,
    };
  },
});
