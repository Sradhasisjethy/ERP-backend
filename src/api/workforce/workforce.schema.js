const { z } = require('zod');
const { isoDate, MAX_TEXT, MAX_SEARCH, MAX_LINES, MAX_QTY, MAX_PAISE } = require('../../utils/zodFields');

const issueMaterialSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    contractorPartyId: z.string().uuid(),
    issueDate: isoDate,
    lines: z.array(z.object({ productId: z.string().uuid(), quantity: z.coerce.number().positive().finite().max(MAX_QTY), lotId: z.string().uuid().optional() })).min(1).max(MAX_LINES),
  }),
});

const createContractorEntrySchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    contractorPartyId: z.string().uuid(),
    productId: z.string().uuid(),
    productionDate: isoDate,
    quantity: z.coerce.number().positive().finite().max(MAX_QTY),
    pieceRatePaiseOverride: z.coerce.number().int().positive().finite().max(MAX_PAISE).optional(),
  }),
});

const markAttendanceSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    labourPartyId: z.string().uuid(),
    attendanceDate: isoDate,
    status: z.enum(['PRESENT', 'HALF_DAY', 'ABSENT', 'OVERTIME']),
    overtimeHours: z.coerce.number().min(0).finite().optional(),
  }),
});

const createAdvanceSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    partyId: z.string().uuid(),
    advanceDate: isoDate,
    mode: z.enum(['CASH', 'BANK']),
    amountPaise: z.coerce.number().int().positive().finite().max(MAX_PAISE),
    reason: z.string().max(MAX_TEXT).optional(),
  }),
});

const cancelSchema = z.object({ body: z.object({ reason: z.string().min(3).max(MAX_TEXT) }) });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  contractorPartyId: z.string().uuid().optional(),
  labourPartyId: z.string().uuid().optional(),
  partyId: z.string().uuid().optional(),
});

module.exports = { issueMaterialSchema, createContractorEntrySchema, markAttendanceSchema, createAdvanceSchema, cancelSchema, listQuerySchema };
