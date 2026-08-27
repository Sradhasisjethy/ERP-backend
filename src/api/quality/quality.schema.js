const { z } = require('zod');

const createInspectionSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    productId: z.string().uuid(),
    inspectionType: z.enum(['INCOMING', 'IN_PROCESS', 'FINAL']),
    inspectionDate: z.string(),

    // A FINAL inspection is about a specific lot; the other two may reference
    // the receipt or the run they belong to instead.
    lotId: z.string().uuid().optional(),
    goodsReceiptId: z.string().uuid().optional(),
    productionEntryId: z.string().uuid().optional(),

    // Age at test in days. Left open rather than fixed at 7/28 so a plant with
    // a different regime is not forced into ours.
    testAgeDays: z.coerce.number().int().min(0).optional(),
    sampleRef: z.string().trim().min(1).optional(),

    testedValue: z.coerce.number().optional(),
    requiredValue: z.coerce.number().optional(),
    unitLabel: z.string().trim().min(1).optional(),

    // Omit to raise the test now and record the verdict later — the normal
    // shape for a cube that will be crushed in three weeks.
    result: z.enum(['PENDING', 'PASS', 'FAIL']).optional(),
    quantityInspected: z.coerce.number().min(0).optional(),
    quantityRejected: z.coerce.number().min(0).optional(),
    remarks: z.string().trim().optional(),
  }),
});

const recordResultSchema = z.object({
  body: z.object({
    result: z.enum(['PASS', 'FAIL']),
    testedValue: z.coerce.number().optional(),
    requiredValue: z.coerce.number().optional(),
    unitLabel: z.string().trim().min(1).optional(),
    quantityRejected: z.coerce.number().min(0).optional(),
    remarks: z.string().trim().optional(),
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
  lotId: z.string().uuid().optional(),
  inspectionType: z.enum(['INCOMING', 'IN_PROCESS', 'FINAL']).optional(),
  result: z.enum(['PENDING', 'PASS', 'FAIL']).optional(),
});

module.exports = { createInspectionSchema, recordResultSchema, listQuerySchema };
