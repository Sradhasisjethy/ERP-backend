const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_LINES, MAX_QTY } = require('../../utils/zodFields');

const createChallanBody = z.object({
  salesOrderId: z.string().uuid(),
  vehicleNumber: z.string().min(1).max(MAX_STRING),
  driverName: z.string().max(MAX_STRING).optional(),
  dispatchDate: isoDate,
  lines: z
    .array(
      z.object({
        salesOrderLineId: z.string().uuid(),
        dispatchedQty: z.coerce.number().positive().finite().max(MAX_QTY),
        overrideLotId: z.string().uuid().optional(),
        overrideLotReason: z.string().max(MAX_TEXT).optional(),
      })
    )
    .min(1).max(MAX_LINES),
});
const createChallanSchema = z.object({ body: createChallanBody });

const cancelChallanSchema = z.object({ body: z.object({ reason: z.string().min(3).max(MAX_TEXT) }) });

const printQuerySchema = z.object({ format: z.enum(['a4', 'thermal']).default('a4') });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  salesOrderId: z.string().uuid().optional(),
  status: z.string().max(MAX_STRING).optional(),
});

module.exports = { createChallanSchema, cancelChallanSchema, printQuerySchema, listQuerySchema };
