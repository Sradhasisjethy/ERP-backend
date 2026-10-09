const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_PAISE } = require('../../utils/zodFields');

const createExpenseSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    expenseDate: isoDate,
    category: z.string().min(1).max(MAX_STRING),
    mode: z.enum(['CASH', 'BANK']),
    amountPaise: z.coerce.number().int().positive().finite().max(MAX_PAISE),
    paidToPartyId: z.string().uuid().optional(),
    // A specific cash or bank account; omit for the system one matching mode.
    accountId: z.string().uuid().optional(),
    description: z.string().max(MAX_TEXT).optional(),
  }),
});

const cancelSchema = z.object({ body: z.object({ reason: z.string().min(3).max(MAX_TEXT) }) });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  category: z.string().max(MAX_STRING).optional(),
});

module.exports = { createExpenseSchema, cancelSchema, listQuerySchema };
