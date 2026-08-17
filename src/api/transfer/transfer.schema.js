const { z } = require('zod');

const initiateTransferBody = z.object({
  fromFactoryId: z.string().uuid(),
  toFactoryId: z.string().uuid(),
  vehicleNumber: z.string().optional(),
  initiatedDate: z.string(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        sourceLotId: z.string().uuid(),
        quantity: z.coerce.number().positive(),
      })
    )
    .min(1),
});
const initiateTransferSchema = z.object({ body: initiateTransferBody });

const receiveTransferSchema = z.object({
  body: z.object({
    receivedDate: z.string(),
    lines: z
      .array(
        z.object({
          lineId: z.string().uuid(),
          receivedQuantity: z.coerce.number().positive().optional(),
        })
      )
      .min(1),
  }),
});

const cancelTransferSchema = z.object({ body: z.object({ reason: z.string().min(3) }) });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  fromFactoryId: z.string().uuid().optional(),
  toFactoryId: z.string().uuid().optional(),
  status: z.enum(['IN_TRANSIT', 'RECEIVED', 'CANCELLED']).optional(),
});

module.exports = { initiateTransferSchema, receiveTransferSchema, cancelTransferSchema, listQuerySchema };
