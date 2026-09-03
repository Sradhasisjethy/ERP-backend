const { z } = require('zod');

const priceListBody = z.object({
  name: z.string().min(1),
  priceType: z.enum(['RETAIL', 'WHOLESALE', 'PARTY_SPECIFIC', 'CONTRACTOR_RATE']),
  partyId: z.string().uuid().nullable().optional().or(z.literal('')),
  customerTier: z.string().nullable().optional(),
  effectiveFrom: z.string().nullable().optional(),
  validUntil: z.string().nullable().optional(),
  rateBasis: z.enum(['TAX_EXCLUSIVE', 'TAX_INCLUSIVE']).optional(),
  isDefault: z.boolean().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        ratePaise: z.coerce.number().int().min(0),
        minQuantity: z.coerce.number().min(0).optional(),
        discountPercent: z.coerce.number().min(0).max(100).optional(),
        effectiveFrom: z.string().nullable().optional(),
      })
    )
    .optional(),
});
const createPriceListSchema = z.object({ body: priceListBody });
const updatePriceListSchema = z.object({
  body: priceListBody.partial().extend({ status: z.enum(['active', 'inactive']).optional() }),
});

const upsertPriceListItemSchema = z.object({
  body: z.object({
    productId: z.string().uuid(),
    ratePaise: z.coerce.number().int().min(0),
    minQuantity: z.coerce.number().min(0).optional(),
    discountPercent: z.coerce.number().min(0).max(100).optional(),
    effectiveFrom: z.string().nullable().optional(),
  }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  search: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  priceType: z.enum(['RETAIL', 'WHOLESALE', 'PARTY_SPECIFIC', 'CONTRACTOR_RATE']).optional(),
  partyId: z.string().uuid().optional(),
});

module.exports = { createPriceListSchema, updatePriceListSchema, upsertPriceListItemSchema, listQuerySchema };
