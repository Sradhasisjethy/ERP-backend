const { z } = require('zod');
const { isoDate, MAX_TEXT, MAX_SEARCH, MAX_LINES, MAX_QTY, MAX_PAISE } = require('../../utils/zodFields');

const returnLineBody = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().positive().finite().max(MAX_QTY),
  ratePaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE),
  lotId: z.string().uuid().optional(),
  overrideReason: z.string().max(MAX_TEXT).optional(),
});

const createSalesReturnSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    customerPartyId: z.string().uuid(),
    salesInvoiceId: z.string().uuid().optional(),
    returnDate: isoDate,
    reason: z.string().min(3).max(MAX_TEXT),
    lines: z.array(returnLineBody).min(1).max(MAX_LINES),
  }),
});

const createPurchaseReturnSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    vendorPartyId: z.string().uuid(),
    returnDate: isoDate,
    reason: z.string().min(3).max(MAX_TEXT),
    lines: z.array(returnLineBody).min(1).max(MAX_LINES),
  }),
});

const createCreditNoteSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    customerPartyId: z.string().uuid(),
    salesInvoiceId: z.string().uuid().optional(),
    noteDate: isoDate,
    reason: z.string().min(3).max(MAX_TEXT),
    amountPaise: z.coerce.number().int().positive().finite().max(MAX_PAISE),
  }),
});

const createDebitNoteSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    vendorPartyId: z.string().uuid(),
    noteDate: isoDate,
    reason: z.string().min(3).max(MAX_TEXT),
    amountPaise: z.coerce.number().int().positive().finite().max(MAX_PAISE),
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
  customerPartyId: z.string().uuid().optional(),
  vendorPartyId: z.string().uuid().optional(),
});

const returnableQuerySchema = z.object({
  factoryId: z.string().uuid(),
  customerPartyId: z.string().uuid(),
});

module.exports = {
  returnableQuerySchema, createSalesReturnSchema, createPurchaseReturnSchema, createCreditNoteSchema, createDebitNoteSchema, cancelSchema, listQuerySchema };
