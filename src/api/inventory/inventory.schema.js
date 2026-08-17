const { z } = require('zod');

const listLotsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  status: z.enum(['CURING', 'AVAILABLE', 'WITH_CONTRACTOR', 'IN_TRANSIT', 'CONSUMED']).optional(),
});

const listLedgerQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  lotId: z.string().uuid().optional(),
  movementType: z.string().optional(),
});

const balanceQuerySchema = z.object({
  factoryId: z.string().uuid(),
  productId: z.string().uuid(),
});

// BR-08 / AC-4.4: early curing release is never allowed without a reason.
const releaseEarlySchema = z.object({ body: z.object({ reason: z.string().min(3) }) });

module.exports = {
  releaseEarlySchema, listLotsQuerySchema, listLedgerQuerySchema, balanceQuerySchema };
