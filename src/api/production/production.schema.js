const { z } = require('zod');

const generateProposalSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    planDate: z.string(),
  }),
});

const confirmPlanSchema = z.object({
  body: z.object({
    lines: z.array(z.object({ lineId: z.string().uuid(), confirmedQty: z.coerce.number().min(0) })).optional(),
  }),
});

const createEntrySchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    productId: z.string().uuid(),
    productionDate: z.string(),
    goodQty: z.coerce.number().positive(),
    rejectedQty: z.coerce.number().min(0).optional(),
    productionPlanLineId: z.string().uuid().optional(),
    materialLines: z
      .array(
        z.object({
          rawMaterialProductId: z.string().uuid(),
          actualQty: z.coerce.number().min(0),
          varianceReason: z.string().optional(),
          overrideLotId: z.string().uuid().optional(),
          overrideLotReason: z.string().optional(),
        })
      )
      .optional(),
  }),
});

const createWastageSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    productId: z.string().uuid(),
    lotId: z.string().uuid().optional(),
    productionEntryId: z.string().uuid().optional(),
    stage: z.enum(['DEMOULDING', 'STACKING', 'HANDLING', 'TRANSIT']),
    quantity: z.coerce.number().positive(),
    reason: z.string().min(3),
    recordedDate: z.string(),
  }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  productId: z.string().uuid().optional(),
  status: z.string().optional(),
  stage: z.string().optional(),
});

module.exports = { generateProposalSchema, confirmPlanSchema, createEntrySchema, createWastageSchema, listQuerySchema };
