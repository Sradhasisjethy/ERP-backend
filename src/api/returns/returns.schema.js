const { z } = require('zod');

const returnLineBody = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  ratePaise: z.coerce.number().int().min(0),
  lotId: z.string().uuid().optional(),
  overrideReason: z.string().optional(),
});

const createSalesReturnSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    customerPartyId: z.string().uuid(),
    salesInvoiceId: z.string().uuid().optional(),
    returnDate: z.string(),
    reason: z.string().min(3),
    lines: z.array(returnLineBody).min(1),
  }),
});

const createPurchaseReturnSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    vendorPartyId: z.string().uuid(),
    returnDate: z.string(),
    reason: z.string().min(3),
    lines: z.array(returnLineBody).min(1),
  }),
});

const createCreditNoteSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    customerPartyId: z.string().uuid(),
    salesInvoiceId: z.string().uuid().optional(),
    noteDate: z.string(),
    reason: z.string().min(3),
    amountPaise: z.coerce.number().int().positive(),
  }),
});

const createDebitNoteSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    vendorPartyId: z.string().uuid(),
    noteDate: z.string(),
    reason: z.string().min(3),
    amountPaise: z.coerce.number().int().positive(),
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
  customerPartyId: z.string().uuid().optional(),
  vendorPartyId: z.string().uuid().optional(),
});

module.exports = { createSalesReturnSchema, createPurchaseReturnSchema, createCreditNoteSchema, createDebitNoteSchema, cancelSchema, listQuerySchema };
