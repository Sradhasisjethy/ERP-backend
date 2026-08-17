const { z } = require('zod');

const createExpenseSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    expenseDate: z.string(),
    category: z.string().min(1),
    mode: z.enum(['CASH', 'BANK']),
    amountPaise: z.coerce.number().int().positive(),
    paidToPartyId: z.string().uuid().optional(),
    description: z.string().optional(),
  }),
});

const cancelSchema = z.object({ body: z.object({ reason: z.string().min(3) }) });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  category: z.string().optional(),
});

module.exports = { createExpenseSchema, cancelSchema, listQuerySchema };
