const { z } = require('zod');

const purchaseOrderBody = z.object({
  factoryId: z.string().uuid(),
  vendorPartyId: z.string().uuid(),
  orderDate: z.string(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        orderedQty: z.coerce.number().positive(),
        ratePaise: z.coerce.number().int().min(0),
      })
    )
    .min(1),
});
const createPurchaseOrderSchema = z.object({ body: purchaseOrderBody });
const cancelPurchaseOrderSchema = z.object({ body: z.object({ reason: z.string().min(3) }) });

const goodsReceiptBody = z.object({
  factoryId: z.string().uuid(),
  vendorPartyId: z.string().uuid(),
  purchaseOrderId: z.string().uuid().optional(),
  receiptDate: z.string(),
  lines: z
    .array(
      z.object({
        productId: z.string().uuid(),
        receivedQty: z.coerce.number().positive(),
        ratePaise: z.coerce.number().int().min(0),
        purchaseOrderLineId: z.string().uuid().optional(),
      })
    )
    .min(1),
});
const createGoodsReceiptSchema = z.object({ body: goodsReceiptBody });

const purchaseInvoiceBody = z.object({
  factoryId: z.string().uuid(),
  goodsReceiptId: z.string().uuid(),
  vendorPartyId: z.string().uuid(),
  vendorInvoiceNumber: z.string().min(1),
  invoiceDate: z.string(),
  dueDate: z.string().optional(),
  amountPaise: z.coerce.number().int().min(0),
});
const createPurchaseInvoiceSchema = z.object({ body: purchaseInvoiceBody });
const updatePaymentStatusSchema = z.object({ body: z.object({ paymentStatus: z.enum(['UNPAID', 'PARTIALLY_PAID', 'PAID']) }) });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  factoryId: z.string().uuid().optional(),
  vendorPartyId: z.string().uuid().optional(),
  purchaseOrderId: z.string().uuid().optional(),
  status: z.string().optional(),
  paymentStatus: z.string().optional(),
});

// FR-M11-1: an indent asks for quantity; price is decided at PO time.
const indentBody = z.object({
  factoryId: z.string().uuid(),
  indentDate: z.string(),
  requiredByDate: z.string().optional(),
  remarks: z.string().optional(),
  lines: z.array(z.object({
    productId: z.string().uuid(),
    quantity: z.coerce.number().positive(),
    remarks: z.string().optional(),
  })).min(1),
});
const createIndentSchema = z.object({ body: indentBody });
const reasonSchema = z.object({ body: z.object({ reason: z.string().min(3) }) });
const convertIndentSchema = z.object({
  body: z.object({
    vendorPartyId: z.string().uuid(),
    orderDate: z.string().optional(),
    expectedDate: z.string().optional(),
    lineRates: z.array(z.object({
      productId: z.string().uuid(),
      ratePaise: z.coerce.number().int().min(0),
    })).min(1),
  }),
});

module.exports = {
  createIndentSchema, reasonSchema, convertIndentSchema,
  createPurchaseOrderSchema,
  cancelPurchaseOrderSchema,
  createGoodsReceiptSchema,
  createPurchaseInvoiceSchema,
  updatePaymentStatusSchema,
  listQuerySchema,
};
