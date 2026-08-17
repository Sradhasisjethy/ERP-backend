const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./payments.controller');
const schema = require('./payments.schema');

const paymentsRouter = Router();

paymentsRouter.use(authenticate, tenantScope, auditContext);

paymentsRouter.get('/receipts', authorize('RECEIPT_READ'), validate(schema.listQuerySchema, 'query'), controller.listReceipts);
paymentsRouter.post('/receipts', authorize('RECEIPT_CREATE'), validate(schema.createReceiptSchema), controller.createReceipt);
paymentsRouter.get('/receipts/:id', authorize('RECEIPT_READ'), controller.getReceipt);
paymentsRouter.put('/receipts/:id/cancel', authorize('RECEIPT_MODIFY'), validate(schema.cancelSchema), controller.cancelReceipt);

paymentsRouter.get('/payments', authorize('PAYMENT_READ'), validate(schema.listQuerySchema, 'query'), controller.listPayments);
paymentsRouter.post('/payments', authorize('PAYMENT_CREATE'), validate(schema.createPaymentSchema), controller.createPayment);
paymentsRouter.get('/payments/:id', authorize('PAYMENT_READ'), controller.getPayment);
paymentsRouter.put('/payments/:id/cancel', authorize('PAYMENT_MODIFY'), validate(schema.cancelSchema), controller.cancelPayment);

// FR-M18-7: cheques are followed from issue to clearance/bounce.
paymentsRouter.get('/cheques', authorize('PAYMENT_READ'), validate(schema.chequeListQuerySchema, 'query'), controller.listCheques);
paymentsRouter.get('/cheques/:id', authorize('PAYMENT_READ'), controller.getCheque);
paymentsRouter.put('/cheques/:id/present', authorize('PAYMENT_MODIFY'), validate(schema.presentSchema), controller.presentCheque);
paymentsRouter.put('/cheques/:id/clear', authorize('PAYMENT_MODIFY'), validate(schema.clearSchema), controller.clearCheque);
paymentsRouter.put('/cheques/:id/bounce', authorize('PAYMENT_MODIFY'), validate(schema.bounceSchema), controller.bounceCheque);
paymentsRouter.put('/cheques/:id/cancel', authorize('PAYMENT_MODIFY'), validate(schema.cancelSchema), controller.cancelCheque);

module.exports = { paymentsRouter };
