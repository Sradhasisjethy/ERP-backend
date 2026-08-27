const { z } = require('zod');

const factoryBody = z.object({
  organizationId: z.string().uuid(),
  name: z.string().min(1),
  code: z.string().min(1),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  allowNegativeStock: z.boolean().optional(),
  allowNegativeCash: z.boolean().optional(),
  // Hold produced lots of qcRequired products until a final inspection
  // passes. Off by default; without this the column existed but nothing
  // outside a SQL client could set it.
  qcHoldEnabled: z.boolean().optional(),
});

const createFactorySchema = z.object({ body: factoryBody });
const updateFactorySchema = z.object({
  body: factoryBody.partial().extend({
    status: z.enum(['active', 'inactive']).optional(),
  }),
});

const financialYearBody = z.object({
  code: z.string().min(1),
  startDate: z.string(),
  endDate: z.string(),
});

const createFinancialYearSchema = z.object({ body: financialYearBody });
const updateFinancialYearSchema = z.object({ body: financialYearBody.partial() });

const assignUserFactorySchema = z.object({
  body: z.object({ userId: z.string().uuid() }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  search: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  organizationId: z.string().uuid().optional(),
});

module.exports = {
  createFactorySchema,
  updateFactorySchema,
  createFinancialYearSchema,
  updateFinancialYearSchema,
  assignUserFactorySchema,
  listQuerySchema,
};
