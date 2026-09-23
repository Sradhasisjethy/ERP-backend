const { z } = require('zod');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD');

const prospectBody = z.object({
  name: z.string().trim().min(1).max(160),
  phone: z.string().trim().max(20).optional(),
  state: z.string().trim().max(60).optional(),
  gstin: z.string().min(15).max(15).optional(),
});

const lineBody = z.object({
  productId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  // Omit to price from the customer's list, then WHOLESALE, then RETAIL.
  ratePaise: z.coerce.number().int().min(0).optional(),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
});

const createQuotationSchema = z.object({
  body: z
    .object({
      factoryId: z.string().uuid(),
      quotationDate: isoDate,
      validUntil: isoDate,
      customerPartyId: z.string().uuid().optional(),
      prospect: prospectBody.optional(),
      // Quoting a lead moves it to QUOTED in the pipeline.
      leadId: z.string().uuid().optional(),
      lines: z.array(lineBody).min(1),
      notes: z.string().max(2000).optional(),
      terms: z.string().max(4000).optional(),
    })
    .refine((b) => b.customerPartyId || b.prospect, {
      message: 'Choose a customer, or give the name of the person you are quoting',
      path: ['customerPartyId'],
    }),
});

const updateQuotationSchema = z.object({
  body: z.object({
    quotationDate: isoDate.optional(),
    validUntil: isoDate.optional(),
    customerPartyId: z.string().uuid().optional(),
    prospect: prospectBody.optional(),
    lines: z.array(lineBody).min(1).optional(),
    notes: z.string().max(2000).optional().nullable(),
    terms: z.string().max(4000).optional().nullable(),
  }),
});

const statusSchema = z.object({
  body: z.object({
    status: z.enum(['SENT', 'ACCEPTED', 'REJECTED', 'CANCELLED']),
    reason: z.string().trim().max(1000).optional(),
  }),
});

const convertSchema = z.object({
  body: z.object({
    orderDate: isoDate.optional(),
    expectedDeliveryDate: isoDate.optional(),
    allowCreditOverride: z.boolean().optional(),
  }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  factoryId: z.string().uuid().optional(),
  customerPartyId: z.string().uuid().optional(),
  // EXPIRED is not a stored status — it means still open and past its date.
  status: z.enum(['DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'CONVERTED', 'CANCELLED', 'EXPIRED']).optional(),
  search: z.string().trim().min(1).optional(),
});

module.exports = { createQuotationSchema, updateQuotationSchema, statusSchema, convertSchema, listQuerySchema };
