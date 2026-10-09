const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_QTY } = require('../../utils/zodFields');

const createInspectionSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    productId: z.string().uuid(),
    inspectionType: z.enum(['INCOMING', 'IN_PROCESS', 'FINAL']),
    inspectionDate: isoDate,

    // A FINAL inspection is about a specific lot; the other two may reference
    // the receipt or the run they belong to instead.
    lotId: z.string().uuid().optional(),
    goodsReceiptId: z.string().uuid().optional(),
    productionEntryId: z.string().uuid().optional(),

    // Age at test in days, anywhere in the plant's testing window (7-28 days
    // here). Stored per result rather than constrained to fixed checkpoints, so
    // a cube crushed on day 12 is as ordinary as one crushed on day 28.
    testAgeDays: z.coerce.number().int().min(0).finite().optional(),
    sampleRef: z.string().trim().min(1).max(MAX_STRING).optional(),

    testedValue: z.coerce.number().finite().optional(),
    requiredValue: z.coerce.number().finite().optional(),
    unitLabel: z.string().trim().min(1).max(MAX_STRING).optional(),

    // Omit to raise the test now and record the verdict later — the normal
    // shape for a cube that will be crushed in three weeks.
    result: z.enum(['PENDING', 'PASS', 'FAIL']).optional(),
    quantityInspected: z.coerce.number().min(0).finite().max(MAX_QTY).optional(),
    quantityRejected: z.coerce.number().min(0).finite().max(MAX_QTY).optional(),
    remarks: z.string().trim().max(MAX_TEXT).optional(),
  }),
});

const recordResultSchema = z.object({
  body: z.object({
    result: z.enum(['PASS', 'FAIL']),
    testedValue: z.coerce.number().finite().optional(),
    requiredValue: z.coerce.number().finite().optional(),
    unitLabel: z.string().trim().min(1).max(MAX_STRING).optional(),
    quantityRejected: z.coerce.number().min(0).finite().max(MAX_QTY).optional(),
    remarks: z.string().trim().max(MAX_TEXT).optional(),
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
  lotId: z.string().uuid().optional(),
  inspectionType: z.enum(['INCOMING', 'IN_PROCESS', 'FINAL']).optional(),
  result: z.enum(['PENDING', 'PASS', 'FAIL']).optional(),
});

module.exports = { createInspectionSchema, recordResultSchema, listQuerySchema };
