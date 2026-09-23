const { z } = require('zod');

const trialBalanceQuerySchema = z.object({ factoryId: z.string().uuid().optional() });

const partyLedgerQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(200).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const cashBookQuerySchema = z.object({
  factoryId: z.string().uuid(),
  from: z.string().optional(),
  to: z.string().optional(),
  accountKey: z.enum(['CASH', 'BANK']).optional(),
  accountId: z.string().uuid().optional(),
});

// Body schemas are wrapped: validate(schema) with no source parses
// { body, query, params } together. Query schemas above are flat.
const openingBalanceBody = z.object({
  factoryId: z.string().uuid(),
  asOfDate: z.string().min(10),
  amountPaise: z.coerce.number().int().positive(),
  side: z.enum(['DEBIT', 'CREDIT']).optional(),
});

const accountFields = {
  name: z.string().trim().min(1).max(120),
  accountGroup: z.string().min(1),
  subType: z.enum(['BANK', 'CASH']).nullable().optional(),
  description: z.string().max(500).nullable().optional(),
  bankName: z.string().max(120).nullable().optional(),
  accountNumber: z.string().max(40).nullable().optional(),
  ifsc: z.string().regex(/^[A-Za-z]{4}0[A-Za-z0-9]{6}$/, 'IFSC must be 11 characters: 4 letters, a zero, then 6 letters or digits').nullable().optional().or(z.literal('')),
  branch: z.string().max(120).nullable().optional(),
};

const createAccountSchema = z.object({
  body: z.object({
    code: z.string().trim().min(1).max(20),
    ...accountFields,
    openingBalance: openingBalanceBody.optional().nullable(),
  }),
});

const updateAccountSchema = z.object({
  body: z.object({
    name: accountFields.name.optional(),
    accountGroup: accountFields.accountGroup.optional(),
    subType: accountFields.subType,
    description: accountFields.description,
    bankName: accountFields.bankName,
    accountNumber: accountFields.accountNumber,
    ifsc: accountFields.ifsc,
    branch: accountFields.branch,
    isActive: z.boolean().optional(),
  }),
});

const accountListQuerySchema = z.object({
  moneyOnly: z.enum(['true', 'false']).optional(),
  subType: z.enum(['BANK', 'CASH']).optional(),
  includeInactive: z.enum(['true', 'false']).optional(),
});

const voucherLineBody = z.object({
  accountId: z.string().uuid(),
  debitPaise: z.coerce.number().int().min(0).default(0),
  creditPaise: z.coerce.number().int().min(0).default(0),
});

const createVoucherSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    voucherType: z.enum(['JOURNAL', 'CONTRA']),
    voucherDate: z.string().min(10),
    narration: z.string().trim().min(1).max(1000),
    lines: z.array(voucherLineBody).min(2).max(50),
  }),
});

const cancelVoucherSchema = z.object({
  body: z.object({ reason: z.string().trim().min(1) }),
});

const voucherListQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  factoryId: z.string().uuid().optional(),
  voucherType: z.enum(['JOURNAL', 'CONTRA']).optional(),
  status: z.enum(['POSTED', 'CANCELLED']).optional(),
  search: z.string().trim().min(1).optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD');

const profitAndLossQuerySchema = z.object({
  from: isoDate.optional(),
  to: isoDate.optional(),
  factoryId: z.string().uuid().optional(),
});

const balanceSheetQuerySchema = z.object({
  asOf: isoDate.optional(),
  factoryId: z.string().uuid().optional(),
});

module.exports = {
  profitAndLossQuerySchema, balanceSheetQuerySchema,
  trialBalanceQuerySchema, partyLedgerQuerySchema, cashBookQuerySchema,
  createAccountSchema, updateAccountSchema, accountListQuerySchema,
  createVoucherSchema, cancelVoucherSchema, voucherListQuerySchema,
};
