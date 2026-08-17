const { z } = require('zod');

const createInvoiceSchema = z.object({
  body: z.object({
    challanIds: z.array(z.string().uuid()).min(1),
    invoiceDate: z.string(),
  }),
});

const cancelInvoiceSchema = z.object({ body: z.object({ reason: z.string().min(3) }) });

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

module.exports = { createInvoiceSchema, cancelInvoiceSchema, listQuerySchema };
