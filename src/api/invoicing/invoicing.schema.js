const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_IDS } = require('../../utils/zodFields');

const createInvoiceSchema = z.object({
  body: z.object({
    challanIds: z.array(z.string().uuid()).min(1).max(MAX_IDS),
    invoiceDate: isoDate,
  }),
});

const cancelInvoiceSchema = z.object({ body: z.object({ reason: z.string().min(3).max(MAX_TEXT) }) });

const listQuerySchema = z.object({
  // Payment screens want only what can still receive money.
  openOnly: z.coerce.boolean().optional(),
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  customerPartyId: z.string().uuid().optional(),
  status: z.string().max(MAX_STRING).optional(),
});

module.exports = { createInvoiceSchema, cancelInvoiceSchema, listQuerySchema };
