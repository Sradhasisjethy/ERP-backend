const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_LINES, MAX_QTY } = require('../../utils/zodFields');

const initiateTransferBody = z.object({
  fromFactoryId: z.string().uuid(),
  toFactoryId: z.string().uuid(),
  vehicleNumber: z.string().max(MAX_STRING).optional(),
  initiatedDate: isoDate,
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        sourceLotId: z.string().uuid(),
        quantity: z.coerce.number().positive().finite().max(MAX_QTY),
      })
    )
    .min(1).max(MAX_LINES),
});
const initiateTransferSchema = z.object({ body: initiateTransferBody });

const receiveTransferSchema = z.object({
  body: z.object({
    receivedDate: isoDate,
    lines: z
      .array(
        z.object({
          lineId: z.string().uuid(),
          receivedQuantity: z.coerce.number().positive().finite().max(MAX_QTY).optional(),
        })
      )
      .min(1).max(MAX_LINES),
  }),
});

const cancelTransferSchema = z.object({ body: z.object({ reason: z.string().min(3).max(MAX_TEXT) }) });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  fromFactoryId: z.string().uuid().optional(),
  toFactoryId: z.string().uuid().optional(),
  status: z.enum(['IN_TRANSIT', 'RECEIVED', 'CANCELLED']).optional(),
});

module.exports = { initiateTransferSchema, receiveTransferSchema, cancelTransferSchema, listQuerySchema };
