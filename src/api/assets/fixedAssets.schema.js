const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_PAISE } = require('../../utils/zodFields');


const paymentBody = z.object({
  mode: z.enum(['CASH', 'BANK']),
  // A specific cash/bank account; omit for the system one matching mode.
  accountId: z.string().uuid().optional(),
});

const createAssetSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    name: z.string().trim().min(1).max(160),
    category: z.string().trim().min(1).max(80),
    serialNumber: z.string().max(80).optional().nullable(),
    description: z.string().max(1000).optional().nullable(),
    acquisitionType: z.enum(['PURCHASED', 'EXISTING']),
    acquisitionDate: isoDate,
    putToUseDate: isoDate.optional(),
    costPaise: z.coerce.number().int().positive().finite().max(MAX_PAISE),
    salvageValuePaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE).optional(),
    method: z.enum(['SLM', 'WDV']),
    usefulLifeMonths: z.coerce.number().int().positive().finite().optional().nullable(),
    ratePercent: z.coerce.number().positive().max(100).finite().optional().nullable(),
    vendorPartyId: z.string().uuid().optional().nullable(),
    payment: paymentBody.optional(),
    // EXISTING only: depreciation already charged before these books began.
    openingAccumulatedPaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE).optional(),
  }),
});

const updateAssetSchema = z.object({
  body: z.object({
    name: z.string().trim().min(1).max(160).optional(),
    category: z.string().trim().min(1).max(80).optional(),
    serialNumber: z.string().max(80).optional().nullable(),
    description: z.string().max(1000).optional().nullable(),
  }),
});

const disposeSchema = z.object({
  body: z.object({
    disposedOn: isoDate,
    proceedsPaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE).optional(),
    payment: paymentBody.optional(),
    note: z.string().max(1000).optional(),
  }),
});

const runSchema = z.object({ body: z.object({ factoryId: z.string().uuid(), upTo: isoDate }) });
const previewQuerySchema = z.object({ factoryId: z.string().uuid(), upTo: isoDate });
const cancelRunSchema = z.object({ body: z.object({ reason: z.string().trim().min(1).max(MAX_TEXT) }) });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  factoryId: z.string().uuid().optional(),
  status: z.enum(['ACTIVE', 'DISPOSED']).optional(),
  category: z.string().max(MAX_STRING).optional(),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
});

const runListQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  factoryId: z.string().uuid().optional(),
});

module.exports = {
  createAssetSchema, updateAssetSchema, disposeSchema, runSchema, previewQuerySchema, cancelRunSchema,
  listQuerySchema, runListQuerySchema,
};
