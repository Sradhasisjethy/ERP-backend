const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_LINES, MAX_QTY } = require('../../utils/zodFields');

const generateProposalSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    planDate: isoDate,
  }),
});

const confirmPlanSchema = z.object({
  body: z.object({
    lines: z.array(z.object({ lineId: z.string().uuid(), confirmedQty: z.coerce.number().min(0).finite().max(MAX_QTY) })).max(MAX_LINES).optional(),
  }),
});

const createEntrySchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    productId: z.string().uuid(),
    productionDate: isoDate,
    goodQty: z.coerce.number().positive().finite().max(MAX_QTY),
    rejectedQty: z.coerce.number().min(0).finite().max(MAX_QTY).optional(),
    productionPlanLineId: z.string().uuid().optional(),
    materialLines: z
      .array(
        z.object({
          rawMaterialProductId: z.string().uuid(),
          actualQty: z.coerce.number().min(0).finite().max(MAX_QTY),
          varianceReason: z.string().max(MAX_TEXT).optional(),
          overrideLotId: z.string().uuid().optional(),
          overrideLotReason: z.string().max(MAX_TEXT).optional(),
        })
      ).max(MAX_LINES)
      .optional(),
  }),
});

const cancelEntrySchema = z.object({
  body: z.object({
    reason: z.string().trim().min(3, 'A cancellation reason is required').max(MAX_TEXT),
  }),
});

const createWastageSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    productId: z.string().uuid(),
    // Required: wastage is stock that no longer exists, so it must come out
    // of a specific lot. The UI has always enforced this; the API had not.
    lotId: z.string().uuid(),
    productionEntryId: z.string().uuid().optional(),
    stage: z.enum(['DEMOULDING', 'STACKING', 'HANDLING', 'TRANSIT']),
    quantity: z.coerce.number().positive().finite().max(MAX_QTY),
    reason: z.string().min(3).max(MAX_TEXT),
    recordedDate: isoDate,
  }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  status: z.string().max(MAX_STRING).optional(),
  stage: z.string().max(MAX_STRING).optional(),
  rawMaterialProductId: z.string().uuid().optional(),
});

module.exports = { generateProposalSchema, confirmPlanSchema, createEntrySchema, cancelEntrySchema, createWastageSchema, listQuerySchema };
