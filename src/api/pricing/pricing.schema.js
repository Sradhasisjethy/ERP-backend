const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_SEARCH, MAX_QTY, MAX_PAISE } = require('../../utils/zodFields');

// A price list can name every product the business sells, so its items are
// capped like an import file rather than like a document's lines.
const MAX_PRICE_LIST_ITEMS = 5000;

const priceListBody = z.object({
  name: z.string().min(1).max(MAX_STRING),
  priceType: z.enum(['RETAIL', 'WHOLESALE', 'PARTY_SPECIFIC', 'CONTRACTOR_RATE']),
  partyId: z.string().uuid().nullable().optional().or(z.literal('')),
  customerTier: z.string().max(MAX_STRING).nullable().optional(),
  effectiveFrom: isoDate.nullable().optional(),
  validUntil: isoDate.nullable().optional(),
  rateBasis: z.enum(['TAX_EXCLUSIVE', 'TAX_INCLUSIVE']).optional(),
  isDefault: z.boolean().optional(),
  items: z
    .array(
      z.object({
        productId: z.string().uuid(),
        ratePaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE),
        minQuantity: z.coerce.number().min(0).finite().max(MAX_QTY).optional(),
        discountPercent: z.coerce.number().min(0).max(100).finite().optional(),
        effectiveFrom: isoDate.nullable().optional(),
      })
    ).max(MAX_PRICE_LIST_ITEMS)
    .optional(),
});
const createPriceListSchema = z.object({ body: priceListBody });
const updatePriceListSchema = z.object({
  body: priceListBody.partial().extend({ status: z.enum(['active', 'inactive']).optional() }),
});

const upsertPriceListItemSchema = z.object({
  body: z.object({
    productId: z.string().uuid(),
    ratePaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE),
    minQuantity: z.coerce.number().min(0).finite().max(MAX_QTY).optional(),
    discountPercent: z.coerce.number().min(0).max(100).finite().optional(),
    effectiveFrom: isoDate.nullable().optional(),
  }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  priceType: z.enum(['RETAIL', 'WHOLESALE', 'PARTY_SPECIFIC', 'CONTRACTOR_RATE']).optional(),
  partyId: z.string().uuid().optional(),
});

module.exports = { createPriceListSchema, updatePriceListSchema, upsertPriceListItemSchema, listQuerySchema };
