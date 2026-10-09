const { z } = require('zod');
const { REPORT_TYPES } = require('./savedReport.model');
const { FORMATS } = require('./export');
const { isoDate: strictIsoDate, MAX_STRING, MAX_SEARCH } = require('../../utils/zodFields');

/**
 * Report request validation.
 *
 * §21: no arbitrary query field ever reaches the database. This schema is the
 * whole vocabulary — anything not named here is stripped by Zod before the
 * controller sees it, and the values that survive are still only ever bound as
 * parameters (never interpolated) by lib/sqlWhere.js. `sortBy` is deliberately
 * a free string here rather than an enum, because the set of valid values is
 * per-report; it is resolved against that report's allow-list in the runner,
 * and an unrecognised value silently falls back to the report's default sort.
 */

const uuid = z.string().uuid().optional();
const isoDate = strictIsoDate.optional();
const token = z.string().trim().min(1).max(64).optional();

const reportQuerySchema = z
  .object({
    page: z.coerce.number().finite().int().min(1).default(1),
    limit: z.coerce.number().finite().int().min(1).max(200).default(25),
    search: z.string().trim().min(1).max(120).optional(),
    sortBy: z.string().trim().min(1).max(64).optional(),
    sortDir: z.enum(['asc', 'desc', 'ASC', 'DESC']).optional(),

    dateFrom: isoDate,
    dateTo: isoDate,

    factoryId: uuid,
    customerId: uuid,
    vendorId: uuid,
    contractorId: uuid,
    labourId: uuid,
    partyId: uuid,
    productId: uuid,
    categoryId: uuid,

    status: token,
    paymentStatus: token,
    movementType: token,
    referenceType: token,
    productType: token,
    stockStatus: token,
    ageingClass: token,
    attendanceStatus: token,
    expenseCategory: z.string().trim().min(1).max(120).optional(),
    paymentMode: token,
    direction: token,
    accountKey: token,
    overdueOnly: z
      .union([z.boolean(), z.enum(['true', 'false'])])
      .transform((v) => v === true || v === 'true')
      .optional(),
  })
  .strict()
  // A backwards range returns nothing and looks like a bug in the data rather
  // than a typo in the filter, so it is rejected outright.
  .refine((q) => !q.dateFrom || !q.dateTo || q.dateFrom <= q.dateTo, {
    message: '"Date from" must be on or before "Date to"',
  });

const exportQuerySchema = reportQuerySchema.innerType().extend({ format: z.enum(FORMATS).default('xlsx') }).strict();

const reportParamsSchema = z.object({
  category: z.string().trim().min(1).max(40),
  report: z.string().trim().min(1).max(60),
});

// --- Saved reports (M40) ---------------------------------------------------

/**
 * `params` used to be `z.record(z.any())`: whatever arrived went to the runner
 * (reports.service.js RUNNERS) and from there into a service call — objects
 * where ids belong, arrays where dates belong, any key at all. Each report
 * type now names the params its runner reads, and nothing else is accepted.
 *
 * The builder form sends a cleared field as '' (and saved params may hold
 * null), which the runners have always read as "not given", so both are
 * treated as absent rather than rejected.
 */
const blank = (schema) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());
const P = {
  factoryId: blank(z.string().uuid()),
  partyId: blank(z.string().uuid()),
  fromDate: blank(strictIsoDate),
  toDate: blank(strictIsoDate),
  from: blank(strictIsoDate),
  to: blank(strictIsoDate),
  deadStockDays: blank(z.coerce.number().finite().int().positive().max(36500)),
  q: blank(z.string().trim().min(2).max(MAX_SEARCH)),
  page: blank(z.coerce.number().finite().int().min(1)),
  limit: blank(z.coerce.number().finite().int().min(1).max(200)),
  accountKey: blank(z.enum(['CASH', 'BANK'])),
};
const pick = (...keys) => z.object(Object.fromEntries(keys.map((k) => [k, P[k]]))).strict();

const PARAMS_BY_TYPE = {
  STOCK_AGEING: pick('factoryId', 'deadStockDays'),
  DASHBOARD_KPIS: pick('factoryId', 'fromDate', 'toDate'),
  COSTING: pick('factoryId'),
  ALERTS: pick('factoryId'),
  CANCELLATION_ANALYTICS: pick('factoryId', 'fromDate', 'toDate'),
  // The direct search endpoint caps at 50; the report runs the same query.
  DOCUMENT_SEARCH: pick('factoryId', 'q').extend({ limit: blank(z.coerce.number().finite().int().min(1).max(50)) }),
  TRIAL_BALANCE: pick('factoryId'),
  PARTY_LEDGER: pick('factoryId', 'partyId', 'page', 'limit'),
  CASH_BOOK: pick('factoryId', 'from', 'to', 'accountKey'),
  GSTR1: pick('factoryId', 'fromDate', 'toDate'),
  GSTR3B: pick('factoryId', 'fromDate', 'toDate'),
};

// Overrides for a saved report are checked before its type is loaded, so they
// get the union of every type's keys — still a closed, typed vocabulary.
const anyReportParams = pick(...Object.keys(P));

/** A body carrying `reportType` + `params`, with params checked against that type. */
const typedReportBody = (shape = {}) =>
  z
    .object({ reportType: z.enum(REPORT_TYPES), params: z.unknown().optional(), ...shape })
    .transform((body, ctx) => {
      if (body.params === undefined) return body;
      const schema = PARAMS_BY_TYPE[body.reportType];
      const parsed = schema.safeParse(body.params);
      if (parsed.success) return { ...body, params: parsed.data };
      for (const issue of parsed.error.issues) {
        ctx.addIssue({ ...issue, path: ['params', ...issue.path], message: `params: ${issue.message}` });
      }
      return z.NEVER;
    });

const createReportSchema = z.object({
  body: typedReportBody({ name: z.string().min(1).max(MAX_STRING) }),
});

const runReportSchema = z.object({ body: typedReportBody() });

const runSavedReportSchema = z.object({ body: z.object({ params: anyReportParams.optional() }) });

const listQuerySchema = z.object({
  page: z.coerce.number().finite().min(1).default(1),
  limit: z.coerce.number().finite().min(1).max(100).default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const exportReportSchema = z.object({
  body: typedReportBody({ format: z.enum(['csv', 'pdf']).optional() }),
});

/**
 * A saved report is addressed by UUID. Anything else used to reach Postgres as
 * `WHERE id = 'sales-summary'` and come back as a 500 — a client typo answered
 * as a server fault.
 */
const idParamsSchema = z.object({ id: z.string().uuid('Report id must be a UUID') });

module.exports = {
  PARAMS_BY_TYPE,
  idParamsSchema,
  reportQuerySchema,
  exportQuerySchema,
  reportParamsSchema,
  exportReportSchema,
  createReportSchema,
  runReportSchema,
  runSavedReportSchema,
  listQuerySchema,
};
