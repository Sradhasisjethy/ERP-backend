const { z } = require('zod');
const {
  isIsoDate, isoDate, optionalIsoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_LINES, MAX_PAISE,
} = require('../../utils/zodFields');

// Whole paise above zero, finite and inside the safe-integer range BIGINT and
// JS arithmetic agree on.
const positivePaise = z.coerce.number().finite().int().positive().max(MAX_PAISE);

/**
 * A cheque lifecycle moment. The columns are timestamps, so a full ISO instant
 * with an explicit offset is accepted as well as a plain calendar day (what
 * the API's own tests and the bounce ledger date use; the screen sends neither
 * and lets the server stamp "now"). Anything else — '05/06/2026', 'yesterday'
 * — used to reach `new Date()` or Postgres to be guessed at. The date part is
 * checked with isIsoDate so '2026-02-30T10:00:00Z' and year 0000 are refused.
 */
const DATETIME = z.string().datetime({ offset: true });
const chequeMoment = z
  .string()
  .max(40)
  .superRefine((value, ctx) => {
    if (isIsoDate(value)) return;
    if (DATETIME.safeParse(value).success && isIsoDate(value.slice(0, 10))) return;
    const field = ctx.path.length ? ctx.path[ctx.path.length - 1] : 'date';
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `${field} must be a date (YYYY-MM-DD) or an ISO timestamp with an offset`,
    });
  })
  .optional();

const modeBody = z.object({
  mode: z.enum(['CASH', 'UPI', 'BANK', 'CHEQUE']),
  amountPaise: positivePaise,
  // FR-M18-3: mode-specific detail. Cheque fields feed the cheque lifecycle
  // (FR-M18-7); `reference` carries a UTR/transaction id for UPI/bank.
  reference: z.string().max(MAX_STRING).optional(),
  chequeNumber: z.string().max(MAX_STRING).optional(),
  // Stored in a DATEONLY column and used as the cheque's date as-is.
  chequeDate: optionalIsoDate,
  bankName: z.string().max(MAX_STRING).optional(),
  // Which of the business's own cash/bank accounts the money went to or came
  // from. Omit for the system Cash-in-Hand (CASH) or Bank Account (others).
  accountId: z.string().uuid().optional(),
});

const allocationBody = z.object({
  // Lower-cased because zod's .uuid() keeps case but Postgres compares uuids
  // case-insensitively: 'ABC…' and 'abc…' passed the duplicate check below as
  // two invoices and then settled the same one twice.
  invoiceId: z.string().uuid().transform((s) => s.toLowerCase()),
  allocatedAmountPaise: positivePaise,
});

// Each invoice at most once per document: the service's over-allocation check
// is per row, so a repeated invoiceId could otherwise settle it twice.
const allocationsBody = z
  .array(allocationBody)
  .max(MAX_LINES)
  .refine((list) => new Set(list.map((a) => a.invoiceId)).size === list.length, {
    message: 'Each invoice can appear only once in allocations — combine the amounts into one line',
  })
  .optional();

const createReceiptSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    customerPartyId: z.string().uuid(),
    receiptDate: isoDate,
    modes: z.array(modeBody).min(1).max(MAX_LINES),
    // invoiceType is always 'SALES' here — inferred by the service, not accepted from the client.
    allocations: allocationsBody,
  }),
});

const createPaymentSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    partyId: z.string().uuid(),
    paymentDate: isoDate,
    modes: z.array(modeBody).min(1).max(MAX_LINES),
    // invoiceType is always 'PURCHASE' here — inferred by the service, not accepted from the client.
    allocations: allocationsBody,
  }),
});

const cancelSchema = z.object({ body: z.object({ reason: z.string().min(3).max(MAX_TEXT) }) });

const listQuerySchema = z.object({
  page: z.coerce.number().finite().int().min(1).default(1),
  limit: z.coerce.number().finite().int().min(1).max(100).default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  customerPartyId: z.string().uuid().optional(),
  partyId: z.string().uuid().optional(),
});

// FR-M18-7
const presentSchema = z.object({ body: z.object({ presentedAt: chequeMoment }) });
const clearSchema = z.object({ body: z.object({ clearedAt: chequeMoment }) });
const bounceSchema = z.object({
  body: z.object({
    reason: z.string().min(3).max(MAX_TEXT),
    bankChargesPaise: z.coerce.number().finite().int().min(0).max(MAX_PAISE).optional(),
    bouncedAt: chequeMoment,
  }),
});
const chequeListQuerySchema = listQuerySchema.extend({
  status: z.enum(['ISSUED', 'PRESENTED', 'CLEARED', 'BOUNCED', 'CANCELLED']).optional(),
  direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
});

module.exports = {
  presentSchema, clearSchema, bounceSchema, chequeListQuerySchema, createReceiptSchema, createPaymentSchema, cancelSchema, listQuerySchema };
