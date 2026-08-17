const { z } = require('zod');
const { REPORT_TYPES } = require('./savedReport.model');
const { FORMATS } = require('./export');

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
const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates must be in YYYY-MM-DD format')
  .optional();
const token = z.string().trim().min(1).max(64).optional();

const reportQuerySchema = z
  .object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(200).default(25),
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

// --- Saved reports (unchanged, M40) ----------------------------------------

const createReportSchema = z.object({
  body: z.object({
    name: z.string().min(1),
    reportType: z.enum(REPORT_TYPES),
    params: z.record(z.any()).optional(),
  }),
});

const runReportSchema = z.object({
  body: z.object({
    reportType: z.enum(REPORT_TYPES),
    params: z.record(z.any()).optional(),
  }),
});

const runSavedReportSchema = z.object({ body: z.object({ params: z.record(z.any()).optional() }) });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const exportReportSchema = z.object({
  body: z.object({
    reportType: z.enum(REPORT_TYPES),
    params: z.record(z.any()).optional(),
    format: z.enum(['csv', 'pdf']).optional(),
  }),
});

module.exports = {
  reportQuerySchema,
  exportQuerySchema,
  reportParamsSchema,
  exportReportSchema,
  createReportSchema,
  runReportSchema,
  runSavedReportSchema,
  listQuerySchema,
};
