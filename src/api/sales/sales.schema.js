const { z } = require('zod');

const salesOrderBody = z.object({
  factoryId: z.string().uuid(),
  customerPartyId: z.string().uuid(),
  orderDate: z.string(),
  expectedDeliveryDate: z.string().optional(),
  poReferenceNumber: z.string().optional(),
  poAttachmentPath: z.string().optional(),
  allowCreditOverride: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        orderedQty: z.coerce.number().positive(),
        ratePaise: z.coerce.number().int().min(0),
      })
    )
    .min(1),
});
const createSalesOrderSchema = z.object({ body: salesOrderBody });

const reasonSchema = z.object({ body: z.object({ reason: z.string().min(3) }) });

const atpQuerySchema = z.object({
  factoryId: z.string().uuid(),
  productId: z.string().uuid(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  customerPartyId: z.string().uuid().optional(),
  status: z.string().optional(),
});

module.exports = { createSalesOrderSchema, reasonSchema, atpQuerySchema, listQuerySchema };
