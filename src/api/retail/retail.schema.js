const { z } = require('zod');

/**
 * Deliberately the same shape as payments.schema.js modeBody — a counter
 * receipt goes through PaymentsService.createReceipt like any other, so the two
 * must accept identical payloads. Kept as its own object rather than imported
 * so a change to one is a visible decision about the other.
 */
const modeBody = z.object({
  mode: z.enum(['CASH', 'UPI', 'BANK', 'CHEQUE']),
  amountPaise: z.coerce.number().int().positive(),
  reference: z.string().optional(),
  chequeNumber: z.string().optional(),
  chequeDate: z.string().optional(),
  bankName: z.string().optional(),
});

/**
 * Either an existing party or enough to create one.
 *
 * `partyId` wins when present. Otherwise `name` is the only hard requirement:
 * a phone lets a repeat buyer be recognised, a state overrides the factory's
 * for place of supply, and a GSTIN — if the walk-in happens to be registered —
 * moves the sale into the B2B half of GSTR-1, which is correct.
 */
const customerFields = z.object({
  partyId: z.string().uuid().optional(),
  name: z.string().min(1).optional(),
  phone: z.string().min(1).optional(),
  state: z.string().min(1).optional(),
  gstin: z.string().min(15).max(15).optional(),
  address: z.string().optional(),
});

/** Naming the buyer is only required at the point of actually selling to them. */
const customerBody = customerFields.refine((c) => c.partyId || (c.name && c.name.trim()), {
  message: 'Provide either an existing customer (partyId) or a name for the walk-in buyer',
});

/**
 * A change to one accessory a bundle rule attached to this line.
 *
 * `qty` and `ratePaise` adjust it; `removed` takes it off the sale and always
 * needs a reason from the configured list (a note too, where that reason asks
 * for one). Removing a mandatory component additionally needs the
 * SALES_BUNDLE_OVERRIDE_MANDATORY grant — the same rule the sales-order flow
 * applies.
 */
const accessoryOverrideBody = z.object({
  componentProductId: z.string().uuid(),
  qty: z.coerce.number().positive().optional(),
  ratePaise: z.coerce.number().int().min(0).optional(),
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  removed: z.boolean().optional(),
  reasonCode: z.string().min(1).optional(),
  reasonNote: z.string().optional(),
});

const lineBody = z.object({
  productId: z.string().uuid(),
  accessoryOverrides: z.array(accessoryOverrideBody).optional(),
  // Comes off the taxable value before GST is charged (s.15(3)(a) CGST Act).
  // Percent, matching price_list_items.discountPercent — the only other
  // discount this schema carries.
  discountPercent: z.coerce.number().min(0).max(100).optional(),
  quantity: z.coerce.number().positive(),
  // Omit to price from the RETAIL price list, then the product's selling price.
  ratePaise: z.coerce.number().int().min(0).optional(),
  // BR-03: selling from a named lot instead of FIFO always needs a reason.
  overrideLotId: z.string().uuid().optional(),
  overrideLotReason: z.string().min(1).optional(),
});

const createCounterSaleSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    invoiceDate: z.string(),
    customer: customerBody,
    lines: z.array(lineBody).min(1),
    // Present when the goods are being sent out rather than carried away. The
    // tax invoice is the document that travels with them, so this is transport
    // detail on the invoice, not a separate delivery challan.
    delivery: z
      .object({
        vehicleNumber: z.string().min(1),
        driverName: z.string().optional(),
      })
      .optional()
      .nullable(),
    // Omit to raise the sale on credit; the invoice posts and the money is
    // collected later through the normal receipts screen.
    payment: z
      .object({
        modes: z.array(modeBody).min(1),
      })
      .optional()
      .nullable(),
  }),
});

/**
 * The same factory, customer and lines a sale takes — no delivery, no payment,
 * because a quote commits nothing. Kept as its own schema rather than a partial
 * of the sale so that adding a field to one is a decision about the other.
 */
const quoteCounterSaleSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    customer: customerFields.optional(),
    lines: z.array(lineBody).min(1),
    // Bundle rules are versioned by date; a quote resolves them on the day the
    // sale will carry, not on the server's today.
    invoiceDate: z.string().optional(),
  }),
});

// Flat, not wrapped in `query`: validate(schema, 'query') parses req.query
// itself, so a wrapper object would make every field read as missing. Body
// schemas above are wrapped, because validate(schema) with no source parses
// { body, query, params } together.
const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  factoryId: z.string().uuid().optional(),
  customerPartyId: z.string().uuid().optional(),
  status: z.enum(['POSTED', 'CANCELLED']).optional(),
  search: z.string().trim().min(1).optional(),
});

module.exports = { createCounterSaleSchema, quoteCounterSaleSchema, listQuerySchema };
