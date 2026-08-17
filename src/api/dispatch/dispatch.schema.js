const { z } = require('zod');

const createChallanBody = z.object({
  salesOrderId: z.string().uuid(),
  vehicleNumber: z.string().min(1),
  driverName: z.string().optional(),
  dispatchDate: z.string(),
  lines: z
    .array(
      z.object({
        salesOrderLineId: z.string().uuid(),
        dispatchedQty: z.coerce.number().positive(),
        overrideLotId: z.string().uuid().optional(),
        overrideLotReason: z.string().optional(),
      })
    )
    .min(1),
});
const createChallanSchema = z.object({ body: createChallanBody });

const cancelChallanSchema = z.object({ body: z.object({ reason: z.string().min(3) }) });

const printQuerySchema = z.object({ format: z.enum(['a4', 'thermal']).default('a4') });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  salesOrderId: z.string().uuid().optional(),
  status: z.string().optional(),
});

module.exports = { createChallanSchema, cancelChallanSchema, printQuerySchema, listQuerySchema };
