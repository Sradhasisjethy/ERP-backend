const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_SEARCH, MAX_LINES, MAX_QTY, MAX_PAISE } = require('../../utils/zodFields');

const uomBody = z.object({
  name: z.string().min(1).max(MAX_STRING),
  code: z.string().min(1).max(MAX_STRING),
  uqc: z.string().max(MAX_STRING).optional(),
});
const createUomSchema = z.object({ body: uomBody });
const updateUomSchema = z.object({ body: uomBody.partial().extend({ status: z.enum(['active', 'inactive']).optional() }) });

const productCategoryBody = z.object({
  name: z.string().min(1).max(MAX_STRING),
  code: z.string().max(MAX_STRING).optional(),
  parentId: z.string().uuid().nullable().optional(),
  // Stock-ageing thresholds; named now that validate() strips undeclared keys.
  slowMovingDays: z.number().int().min(1).finite().nullable().optional(),
  deadStockDays: z.number().int().min(1).finite().nullable().optional(),
  alertBeforeDays: z.number().int().min(0).finite().nullable().optional(),
});
const createProductCategorySchema = z.object({ body: productCategoryBody });
const updateProductCategorySchema = z.object({
  body: productCategoryBody.partial().extend({ status: z.enum(['active', 'inactive']).optional() }),
});

const hsnCodeBody = z.object({
  code: z.string().min(1).max(MAX_STRING),
  description: z.string().max(255).optional(),
  gstRatePercent: z.coerce.number().min(0).max(100).finite().optional(),
  codeType: z.enum(['HSN', 'SAC']).optional(),
  cessPercent: z.coerce.number().min(0).max(100).finite().optional(),
});
const createHsnCodeSchema = z.object({ body: hsnCodeBody });
const updateHsnCodeSchema = z.object({ body: hsnCodeBody.partial().extend({ status: z.enum(['active', 'inactive']).optional() }) });

const productBody = z.object({
  categoryId: z.string().uuid().optional(),
  uomId: z.string().uuid(),
  hsnId: z.string().uuid().optional(),
  name: z.string().min(1).max(MAX_STRING),
  code: z.string().min(1).max(MAX_STRING),
  productType: z.enum(['FINISHED_GOOD', 'RAW_MATERIAL']).optional(),
  curingDays: z.coerce.number().int().min(0).finite().optional(),
  // Does a produced lot of this product need a passing test before it can
  // be sold? Independent of curingDays, which is about age, not strength.
  qcRequired: z.boolean().optional(),
  isAccessory: z.boolean().optional(),
  standardCostPaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE).optional(),
  sellingPricePaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE).optional(),
  openingStockQty: z.coerce.number().min(0).finite().max(MAX_QTY).optional(),
  openingStockRatePaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE).optional(),
  openingStockDate: isoDate.optional(),
  defaultLocation: z.string().max(MAX_STRING).optional(),
  reorderLevel: z.coerce.number().min(0).finite().optional(),
  minStock: z.coerce.number().min(0).finite().optional(),
  maxStock: z.coerce.number().min(0).finite().optional(),
  slowMovingDays: z.coerce.number().int().min(1).finite().optional(),
  deadStockDays: z.coerce.number().int().min(1).finite().optional(),
  alertBeforeDays: z.coerce.number().int().min(0).finite().optional(),
});
const stockRangeIsCoherent = (body) =>
  body.minStock === undefined || body.maxStock === undefined || Number(body.maxStock) >= Number(body.minStock);
const STOCK_RANGE_ERROR = { message: 'Maximum stock cannot be lower than minimum stock', path: ['maxStock'] };

const createProductSchema = z.object({ body: productBody.refine(stockRangeIsCoherent, STOCK_RANGE_ERROR) });
// The update path only sees the fields the request carries, so a patch that
// moves just one end of the range is re-checked against the stored row in
// ProductsService.updateProduct.
const updateProductSchema = z.object({
  body: productBody.partial().extend({ status: z.enum(['active', 'inactive']).optional() }).refine(stockRangeIsCoherent, STOCK_RANGE_ERROR),
});

const mixDesignBody = z.object({
  productId: z.string().uuid(),
  name: z.string().min(1).max(MAX_STRING),
  version: z.coerce.number().int().min(1).finite().optional(),
  effectiveFrom: isoDate.optional(),
  outputQuantity: z.coerce.number().positive().finite().max(MAX_QTY).optional(),
  bomType: z.enum(['MANUFACTURING', 'ASSEMBLY']).optional(),
  laborCostPaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE).optional(),
  overheadCostPaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE).optional(),
  // Create-and-activate in one step; the usual choice for a product's first BOM.
  activate: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        rawMaterialProductId: z.string().uuid(),
        quantityPerUnit: z.coerce.number().positive().finite().max(MAX_QTY),
        uomId: z.string().uuid(),
        wastagePercent: z.coerce.number().min(0).max(100).finite().optional(),
        isOptional: z.boolean().optional(),
      })
    )
    .min(1).max(MAX_LINES),
});
const createMixDesignSchema = z.object({ body: mixDesignBody });
const updateMixDesignSchema = z.object({
  body: mixDesignBody.partial().extend({ lines: mixDesignBody.shape.lines.optional() }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  categoryId: z.string().uuid().optional(),
  productType: z.enum(['FINISHED_GOOD', 'RAW_MATERIAL']).optional(),
  // A string over the wire; coerced so ?isAccessory=false filters rather than
  // being read as the truthy string "false".
  isAccessory: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  productId: z.string().uuid().optional(),
  bomStatus: z.enum(['DRAFT', 'ACTIVE', 'SUPERSEDED']).optional(),
});

// FR-M03-2: conversions between units, e.g. 1 Bag = 50 Kg.
const uomConversionBody = z.object({
  fromUomId: z.string().uuid(),
  toUomId: z.string().uuid(),
  factor: z.coerce.number().positive().finite(),
  status: z.enum(['active', 'inactive']).optional(),
});
const createUomConversionSchema = z.object({ body: uomConversionBody });
const updateUomConversionSchema = z.object({ body: uomConversionBody.partial() });
const convertQuerySchema = z.object({
  quantity: z.coerce.number().finite().max(MAX_QTY),
  fromUomId: z.string().uuid(),
  toUomId: z.string().uuid(),
});

const cloneMixDesignSchema = z.object({ body: z.object({ name: z.string().min(1).max(MAX_STRING).optional() }) });
const activateMixDesignSchema = z.object({ body: z.object({ effectiveFrom: isoDate.optional() }) });
const explodeQuerySchema = z.object({ outputQty: z.coerce.number().positive().finite().max(MAX_QTY).default(1) });

// Which mix design is in force for a product on a given date. Production
// consumes the date-effective recipe, so any screen that lets a user pick a
// production date has to ask the same question the posting code asks.
/**
 * Query for GET /products/:id/bundle-preview. Everything is optional except the
 * quantity, because the sales screen calls this the moment a product is picked
 * — before a customer or a delivery location has necessarily been chosen.
 */
const bundlePreviewQuerySchema = z.object({
  qty: z.coerce.number().positive().finite().max(MAX_QTY).default(1),
  factoryId: z.string().uuid().optional(),
  partyId: z.string().uuid().optional(),
  priceType: z.string().trim().min(1).max(MAX_STRING).optional(),
  onDate: isoDate.optional(),
});

const resolveMixDesignQuerySchema = z.object({
  productId: z.string().uuid(),
  onDate: isoDate.optional(),
});

module.exports = {
  createUomConversionSchema, updateUomConversionSchema, convertQuerySchema,
  cloneMixDesignSchema, activateMixDesignSchema, explodeQuerySchema, resolveMixDesignQuerySchema,
  bundlePreviewQuerySchema,
  createUomSchema,
  updateUomSchema,
  createProductCategorySchema,
  updateProductCategorySchema,
  createHsnCodeSchema,
  updateHsnCodeSchema,
  createProductSchema,
  updateProductSchema,
  createMixDesignSchema,
  updateMixDesignSchema,
  listQuerySchema,
};
