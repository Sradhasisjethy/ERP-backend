const { z } = require('zod');

const issueMaterialSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    contractorPartyId: z.string().uuid(),
    issueDate: z.string(),
    lines: z.array(z.object({ productId: z.string().uuid(), quantity: z.coerce.number().positive(), lotId: z.string().uuid().optional() })).min(1),
  }),
});

const createContractorEntrySchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    contractorPartyId: z.string().uuid(),
    productId: z.string().uuid(),
    productionDate: z.string(),
    quantity: z.coerce.number().positive(),
    pieceRatePaiseOverride: z.coerce.number().int().positive().optional(),
  }),
});

const markAttendanceSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    labourPartyId: z.string().uuid(),
    attendanceDate: z.string(),
    status: z.enum(['PRESENT', 'HALF_DAY', 'ABSENT', 'OVERTIME']),
    overtimeHours: z.coerce.number().min(0).optional(),
  }),
});

const createAdvanceSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    partyId: z.string().uuid(),
    advanceDate: z.string(),
    mode: z.enum(['CASH', 'BANK']),
    amountPaise: z.coerce.number().int().positive(),
    reason: z.string().optional(),
  }),
});

const cancelSchema = z.object({ body: z.object({ reason: z.string().min(3) }) });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  contractorPartyId: z.string().uuid().optional(),
  labourPartyId: z.string().uuid().optional(),
  partyId: z.string().uuid().optional(),
});

module.exports = { issueMaterialSchema, createContractorEntrySchema, markAttendanceSchema, createAdvanceSchema, cancelSchema, listQuerySchema };
