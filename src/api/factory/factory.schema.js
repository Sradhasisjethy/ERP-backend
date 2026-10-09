const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH } = require('../../utils/zodFields');

// The plant code is folded into every document number (SO/PA/0001), and from
// there into PDF filenames and GST invoice numbers — which allow 16 characters
// of A-Z, 0-9, '/' and '-'. A quote broke the Content-Disposition header and a
// non-Latin-1 character made every PDF of that plant a 500. Ten characters
// leaves room for the type prefix and the sequence within the GST limit.
const FACTORY_CODE_PATTERN = /^[A-Z0-9-]{1,10}$/;
const factoryCode = z.string().trim().toUpperCase().regex(
  FACTORY_CODE_PATTERN,
  'Code must be 1-10 characters: letters, digits or hyphen'
);

const factoryBody = z.object({
  organizationId: z.string().uuid(),
  name: z.string().min(1).max(MAX_STRING),
  code: factoryCode,
  address: z.string().max(MAX_TEXT).optional(),
  city: z.string().max(MAX_STRING).optional(),
  state: z.string().max(MAX_STRING).optional(),
  allowNegativeStock: z.boolean().optional(),
  allowNegativeCash: z.boolean().optional(),
  // Hold produced lots of qcRequired products until a final inspection
  // passes. Off by default; without this the column existed but nothing
  // outside a SQL client could set it.
  qcHoldEnabled: z.boolean().optional(),
  // Per-plant thresholds. They were settable only because validate() used to
  // pass undeclared keys through; now that it strips them, they are named.
  varianceThresholdPercent: z.coerce.number().min(0).max(100).finite().optional(),
  dispatchTolerancePercent: z.coerce.number().min(0).max(100).finite().optional(),
  slowMovingDays: z.number().int().min(1).finite().nullable().optional(),
  deadStockDays: z.number().int().min(1).finite().nullable().optional(),
  alertBeforeDays: z.number().int().min(0).finite().nullable().optional(),
});

const createFactorySchema = z.object({ body: factoryBody });
const updateFactorySchema = z.object({
  body: factoryBody.partial().extend({
    status: z.enum(['active', 'inactive']).optional(),
  }),
});

const financialYearBody = z.object({
  code: z.string().trim().min(1, 'Code is required').max(MAX_STRING),
  startDate: isoDate,
  endDate: isoDate.optional(),
  status: z.enum(['PLANNED', 'ACTIVE', 'SOFT_CLOSED', 'CLOSED']).optional(),
  isCurrent: z.boolean().optional(),
});

const createFinancialYearSchema = z.object({ body: financialYearBody });
const updateFinancialYearSchema = z.object({ body: financialYearBody.partial() });
const updateFinancialYearStatusSchema = z.object({
  body: z.object({
    status: z.enum(['PLANNED', 'ACTIVE', 'SOFT_CLOSED', 'CLOSED']),
  }),
});

const assignUserFactorySchema = z.object({
  body: z.object({ userId: z.string().uuid() }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  organizationId: z.string().uuid().optional(),
});

module.exports = {
  FACTORY_CODE_PATTERN,
  createFactorySchema,
  updateFactorySchema,
  createFinancialYearSchema,
  updateFinancialYearSchema,
  updateFinancialYearStatusSchema,
  assignUserFactorySchema,
  listQuerySchema,
};
