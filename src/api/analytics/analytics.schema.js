const { z } = require('zod');

const stockAgeingQuerySchema = z.object({
  factoryId: z.string().uuid(),
  deadStockDays: z.coerce.number().int().positive().optional(),
});

const dashboardQuerySchema = z.object({
  factoryId: z.string().uuid(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

const costingQuerySchema = z.object({ factoryId: z.string().uuid() });

const alertsQuerySchema = z.object({ factoryId: z.string().uuid() });

const cancellationQuerySchema = z.object({
  factoryId: z.string().uuid(),
  fromDate: z.string().optional(),
  toDate: z.string().optional(),
});

const searchQuerySchema = z.object({
  q: z.string().min(2),
  limit: z.coerce.number().min(1).max(50).default(10),
});

module.exports = { stockAgeingQuerySchema, dashboardQuerySchema, costingQuerySchema, alertsQuerySchema, cancellationQuerySchema, searchQuerySchema };
