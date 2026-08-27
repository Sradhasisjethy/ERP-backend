const { z } = require('zod');

const listLotsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  status: z.enum(['CURING', 'AVAILABLE', 'WITH_CONTRACTOR', 'IN_TRANSIT', 'CONSUMED', 'QC_HOLD', 'QC_FAILED']).optional(),
});

const listReservationsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  factoryId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'RELEASED', 'CONSUMED']).optional(),
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

const listAdjustmentsQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  lotId: z.string().uuid().optional(),
});

/**
 * `countedQty` is what was physically found — an absolute figure, not a delta.
 * Taking the count is what makes the operation safe under concurrency: the
 * service reads the system quantity under the same row lock it posts with, so
 * two people counting the same lot cannot both apply a difference computed
 * against a stale number.
 */
const createAdjustmentSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    productId: z.string().uuid(),
    lotId: z.string().uuid(),
    countedQty: z.coerce.number().min(0),
    reason: z.string().trim().min(3, 'An unexplained stock correction is not auditable'),
    adjustmentDate: z.string().optional(),
  }),
});

// BR-08 / AC-4.4: early curing release is never allowed without a reason.
const releaseEarlySchema = z.object({ body: z.object({ reason: z.string().min(3) }) });

module.exports = {
  listReservationsQuerySchema,
  releaseEarlySchema, listLotsQuerySchema, listLedgerQuerySchema, balanceQuerySchema,
  listAdjustmentsQuerySchema, createAdjustmentSchema };
