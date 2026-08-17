const { z } = require('zod');

const modeBody = z.object({
  mode: z.enum(['CASH', 'UPI', 'BANK', 'CHEQUE']),
  amountPaise: z.coerce.number().int().positive(),
  // FR-M18-3: mode-specific detail. Cheque fields feed the cheque lifecycle
  // (FR-M18-7); `reference` carries a UTR/transaction id for UPI/bank.
  reference: z.string().optional(),
  chequeNumber: z.string().optional(),
  chequeDate: z.string().optional(),
  bankName: z.string().optional(),
});

const allocationBody = z.object({
  invoiceId: z.string().uuid(),
  allocatedAmountPaise: z.coerce.number().int().positive(),
});

const createReceiptSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    customerPartyId: z.string().uuid(),
    receiptDate: z.string(),
    modes: z.array(modeBody).min(1),
    // invoiceType is always 'SALES' here — inferred by the service, not accepted from the client.
    allocations: z.array(allocationBody).optional(),
  }),
});

const createPaymentSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    partyId: z.string().uuid(),
    paymentDate: z.string(),
    modes: z.array(modeBody).min(1),
    // invoiceType is always 'PURCHASE' here — inferred by the service, not accepted from the client.
    allocations: z.array(allocationBody).optional(),
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
  customerPartyId: z.string().uuid().optional(),
  partyId: z.string().uuid().optional(),
});

// FR-M18-7
const presentSchema = z.object({ body: z.object({ presentedAt: z.string().optional() }) });
const clearSchema = z.object({ body: z.object({ clearedAt: z.string().optional() }) });
const bounceSchema = z.object({
  body: z.object({
    reason: z.string().min(3),
    bankChargesPaise: z.coerce.number().int().min(0).optional(),
    bouncedAt: z.string().optional(),
  }),
});
const chequeListQuerySchema = listQuerySchema.extend({
  status: z.enum(['ISSUED', 'PRESENTED', 'CLEARED', 'BOUNCED', 'CANCELLED']).optional(),
  direction: z.enum(['INBOUND', 'OUTBOUND']).optional(),
});

module.exports = {
  presentSchema, clearSchema, bounceSchema, chequeListQuerySchema, createReceiptSchema, createPaymentSchema, cancelSchema, listQuerySchema };
