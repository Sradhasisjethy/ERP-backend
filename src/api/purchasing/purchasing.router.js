const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./purchasing.controller');
const schema = require('./purchasing.schema');

const purchasingRouter = Router();

purchasingRouter.use(authenticate, tenantScope, auditContext);

purchasingRouter.get('/orders', authorize('PURCHASE_READ'), validate(schema.listQuerySchema, 'query'), controller.listPurchaseOrders);
purchasingRouter.post('/orders', authorize('PURCHASE_CREATE'), validate(schema.createPurchaseOrderSchema), controller.createPurchaseOrder);
purchasingRouter.get('/orders/:id', authorize('PURCHASE_READ'), controller.getPurchaseOrder);
purchasingRouter.put('/orders/:id', authorize('PURCHASE_MODIFY'), validate(schema.updatePurchaseOrderSchema), controller.updatePurchaseOrder);
purchasingRouter.put('/orders/:id/confirm', authorize('PURCHASE_MODIFY'), controller.confirmPurchaseOrder);
purchasingRouter.put('/orders/:id/cancel', authorize('PURCHASE_MODIFY'), validate(schema.cancelPurchaseOrderSchema), controller.cancelPurchaseOrder);

purchasingRouter.get('/receipts', authorize('PURCHASE_READ'), validate(schema.listQuerySchema, 'query'), controller.listGoodsReceipts);
purchasingRouter.post('/receipts', authorize('PURCHASE_CREATE'), validate(schema.createGoodsReceiptSchema), controller.createGoodsReceipt);
purchasingRouter.get('/receipts/:id', authorize('PURCHASE_READ'), controller.getGoodsReceipt);
// Reversing a posted stock receipt is a higher-consequence act than editing a
// draft, so it takes DELETE rights rather than MODIFY.
purchasingRouter.put('/receipts/:id/cancel', authorize('PURCHASE_DELETE'), validate(schema.reasonSchema), controller.cancelGoodsReceipt);

purchasingRouter.get('/invoices', authorize('PURCHASE_READ'), validate(schema.listQuerySchema, 'query'), controller.listPurchaseInvoices);
purchasingRouter.post('/invoices', authorize('PURCHASE_CREATE'), validate(schema.createPurchaseInvoiceSchema), controller.createPurchaseInvoice);
purchasingRouter.get('/invoices/:id', authorize('PURCHASE_READ'), controller.getPurchaseInvoice);
// There is deliberately no endpoint to set paymentStatus by hand. It is
// derived from allocations by PaymentsService; letting it be written directly
// allowed an unpaid invoice to be marked PAID with no money behind it, while
// the ledger still carried the payable.
purchasingRouter.put('/invoices/:id/cancel', authorize('PURCHASE_DELETE'), validate(schema.reasonSchema), controller.cancelPurchaseInvoice);

// FR-M11-1: indents are raised, approved, then converted into a PO.
purchasingRouter.get('/indents', authorize('PURCHASE_READ'), validate(schema.listQuerySchema, 'query'), controller.listIndents);
purchasingRouter.post('/indents', authorize('PURCHASE_CREATE'), validate(schema.createIndentSchema), controller.createIndent);
purchasingRouter.get('/indents/:id', authorize('PURCHASE_READ'), controller.getIndent);
purchasingRouter.put('/indents/:id/approve', authorize('PURCHASE_APPROVE'), controller.approveIndent);
purchasingRouter.put('/indents/:id/reject', authorize('PURCHASE_APPROVE'), validate(schema.reasonSchema), controller.rejectIndent);
purchasingRouter.put('/indents/:id/cancel', authorize('PURCHASE_MODIFY'), validate(schema.reasonSchema), controller.cancelIndent);
purchasingRouter.post('/indents/:id/convert', authorize('PURCHASE_CREATE'), validate(schema.convertIndentSchema), controller.convertIndent);

// FR-M11-6: PO <-> GRN <-> Invoice comparison.
purchasingRouter.get('/invoices/:id/three-way-match', authorize('PURCHASE_READ'), controller.threeWayMatch);

module.exports = { purchasingRouter };
