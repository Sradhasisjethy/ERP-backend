const { z } = require('zod');

const trialBalanceQuerySchema = z.object({ factoryId: z.string().uuid().optional() });

const partyLedgerQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(200).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const cashBookQuerySchema = z.object({
  factoryId: z.string().uuid(),
  from: z.string().optional(),
  to: z.string().optional(),
  accountKey: z.enum(['CASH', 'BANK']).optional(),
});

module.exports = { trialBalanceQuerySchema, partyLedgerQuerySchema, cashBookQuerySchema };
