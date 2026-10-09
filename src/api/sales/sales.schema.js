const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_LINES, MAX_QTY, MAX_PAISE } = require('../../utils/zodFields');

const salesOrderBody = z.object({
  factoryId: z.string().uuid(),
  customerPartyId: z.string().uuid(),
  orderDate: isoDate,
  expectedDeliveryDate: isoDate.optional(),
  poReferenceNumber: z.string().max(MAX_STRING).optional(),
  poAttachmentPath: z.string().max(MAX_STRING).optional(),
  allowCreditOverride: z.boolean().optional(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        orderedQty: z.coerce.number().positive().finite().max(MAX_QTY),
        ratePaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE),
        // Decisions about this line's accessories, made while the order is
        // being typed rather than after it is saved. A salesperson on the phone
        // needs to say "no gasket, and make it four hooks" there and then;
        // making them save first and edit afterwards is how a wrong line ends
        // up on a challan.
        //
        // One field for both kinds of decision because they are the same kind
        // of thing — a departure from what the bundle says — and the server
        // applies each through the same command the edit screen uses, so the
        // audit trail cannot tell the two routes apart.
        accessoryOverrides: z
          .array(
            z
              .object({
                componentProductId: z.string().uuid(),
                exclude: z.boolean().optional(),
                qty: z.coerce.number().positive().finite().max(MAX_QTY).optional(),
                reasonCode: z.string().trim().min(1).max(50).optional(),
                reasonNote: z.string().trim().min(1).max(MAX_TEXT).optional(),
              })
              // A removal without a reason is what makes the attach-rate report
              // meaningless, so it is refused at the edge rather than defaulted.
              .refine((o) => !o.exclude || !!o.reasonCode, {
                message: 'Leaving an accessory off needs a reason code',
                path: ['reasonCode'],
              })
              .refine((o) => o.exclude || o.qty !== undefined, {
                message: 'An accessory override must either exclude it or set a quantity',
              })
          ).max(MAX_LINES)
          .optional(),
      })
    )
    .min(1).max(MAX_LINES),
});
const createSalesOrderSchema = z.object({ body: salesOrderBody });

// Edit is DRAFT-only and partial: `lines` replaces the whole set when present,
// and is left untouched when absent. factoryId is not editable — see
// SalesService.updateSalesOrder for why.
const updateSalesOrderSchema = z.object({
  body: salesOrderBody.partial().omit({ factoryId: true }),
});

const reasonSchema = z.object({ body: z.object({ reason: z.string().min(3).max(MAX_TEXT) }) });

const atpQuerySchema = z.object({
  factoryId: z.string().uuid(),
  productId: z.string().uuid(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  customerPartyId: z.string().uuid().optional(),
  status: z.string().max(MAX_STRING).optional(),
});

// ---- bundle commands (docs/specs/bundle-kitting.md §6) --------------------
//
// Wrapped in `{ body: ... }` because `validate()` with no explicit source
// checks { body, query, params } as one object.

const addLineSchema = z.object({
  body: z.object({
    productId: z.string().uuid(),
    orderedQty: z.coerce.number().positive().finite().max(MAX_QTY),
    // Omitted means "use the price list", which is the normal case; sending one
    // is an explicit override.
    ratePaise: z.coerce.number().int().nonnegative().finite().max(MAX_PAISE).optional(),
  }),
});

const changeQuantitySchema = z.object({
  body: z.object({ qty: z.coerce.number().positive().finite().max(MAX_QTY) }),
});

const suppressSchema = z.object({
  body: z.object({
    reasonCode: z.string().trim().min(1, 'Choose a reason for removing this item').max(50),
    reasonNote: z.string().trim().min(1).max(MAX_TEXT).optional(),
  }),
});

const restoreSchema = z.object({
  body: z.object({ componentProductId: z.string().uuid() }),
});

const addComponentSchema = z.object({
  body: z.object({
    productId: z.string().uuid(),
    qty: z.coerce.number().positive().finite().max(MAX_QTY).optional(),
  }),
});

module.exports = { createSalesOrderSchema, updateSalesOrderSchema, reasonSchema, atpQuerySchema, listQuerySchema,
  addLineSchema, changeQuantitySchema, suppressSchema, restoreSchema, addComponentSchema };
