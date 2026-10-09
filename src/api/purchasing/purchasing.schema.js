const { z } = require('zod');
const { isoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_LINES, MAX_QTY, MAX_PAISE } = require('../../utils/zodFields');

const purchaseOrderBody = z.object({
  factoryId: z.string().uuid(),
  vendorPartyId: z.string().uuid(),
  orderDate: isoDate,
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        orderedQty: z.coerce.number().positive().finite().max(MAX_QTY),
        ratePaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE),
      })
    )
    .min(1).max(MAX_LINES),
});
const createPurchaseOrderSchema = z.object({ body: purchaseOrderBody });
// Edit is DRAFT-only; `lines` replaces the whole set when present. factoryId is
// not editable — the PO number came from that factory's series.
const updatePurchaseOrderSchema = z.object({ body: purchaseOrderBody.partial().omit({ factoryId: true }) });
const cancelPurchaseOrderSchema = z.object({ body: z.object({ reason: z.string().min(3).max(MAX_TEXT) }) });

const goodsReceiptBody = z.object({
  factoryId: z.string().uuid(),
  vendorPartyId: z.string().uuid(),
  purchaseOrderId: z.string().uuid().optional(),
  receiptDate: isoDate,
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        receivedQty: z.coerce.number().positive().finite().max(MAX_QTY),
        // QC-01: quantity turned away at the gate. Optional and zero by
        // default, so a receipt that says nothing about quality still stocks
        // the whole delivery exactly as it did before.
        rejectedQty: z.coerce.number().min(0).finite().max(MAX_QTY).optional(),
        rejectionReason: z.string().trim().min(3).max(MAX_TEXT).optional(),
        ratePaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE),
        purchaseOrderLineId: z.string().uuid().optional(),
      })
    )
    .min(1).max(MAX_LINES),
});
const createGoodsReceiptSchema = z.object({ body: goodsReceiptBody });

const purchaseInvoiceBody = z.object({
  factoryId: z.string().uuid(),
  goodsReceiptId: z.string().uuid(),
  vendorPartyId: z.string().uuid(),
  vendorInvoiceNumber: z.string().min(1).max(MAX_STRING),
  invoiceDate: isoDate,
  dueDate: isoDate.optional(),
  amountPaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE),
});
const createPurchaseInvoiceSchema = z.object({ body: purchaseInvoiceBody });
// paymentStatus is derived, never submitted — see purchasing.router.js.

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  vendorPartyId: z.string().uuid().optional(),
  purchaseOrderId: z.string().uuid().optional(),
  status: z.string().max(MAX_STRING).optional(),
  paymentStatus: z.string().max(MAX_STRING).optional(),
});

// FR-M11-1: an indent asks for quantity; price is decided at PO time.
const indentBody = z.object({
  factoryId: z.string().uuid(),
  indentDate: isoDate,
  requiredByDate: isoDate.optional(),
  remarks: z.string().max(MAX_TEXT).optional(),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.coerce.number().positive().finite().max(MAX_QTY),
    remarks: z.string().max(MAX_TEXT).optional(),
  })).min(1).max(MAX_LINES),
});
const createIndentSchema = z.object({ body: indentBody });
const reasonSchema = z.object({ body: z.object({ reason: z.string().min(3).max(MAX_TEXT) }) });
const convertIndentSchema = z.object({
  body: z.object({
    vendorPartyId: z.string().uuid(),
    orderDate: isoDate.optional(),
    expectedDate: isoDate.optional(),
    lineRates: z.array(z.object({
      productId: z.string().uuid(),
      ratePaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE),
    })).min(1).max(MAX_LINES),
  }),
});

module.exports = {
  createIndentSchema, reasonSchema, convertIndentSchema,
  createPurchaseOrderSchema,
  updatePurchaseOrderSchema,
  cancelPurchaseOrderSchema,
  createGoodsReceiptSchema,
  createPurchaseInvoiceSchema,
  listQuerySchema,
};
