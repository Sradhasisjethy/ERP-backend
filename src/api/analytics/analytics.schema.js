const { z } = require('zod');
const { isoDate, MAX_SEARCH } = require('../../utils/zodFields');

const stockAgeingQuerySchema = z.object({
  factoryId: z.string().uuid(),
  deadStockDays: z.coerce.number().int().positive().finite().optional(),
});

const dashboardQuerySchema = z.object({
  factoryId: z.string().uuid(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});

const costingQuerySchema = z.object({ factoryId: z.string().uuid() });

const alertsQuerySchema = z.object({ factoryId: z.string().uuid() });

const cancellationQuerySchema = z.object({
  factoryId: z.string().uuid(),
  fromDate: isoDate.optional(),
  toDate: isoDate.optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(2).max(MAX_SEARCH),
  limit: z.coerce.number().min(1).max(50).finite().default(10),
});

module.exports = { stockAgeingQuerySchema, dashboardQuerySchema, costingQuerySchema, alertsQuerySchema, cancellationQuerySchema, searchQuerySchema };
