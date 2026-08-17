const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./returns.controller');
const schema = require('./returns.schema');

const returnsRouter = Router();

returnsRouter.use(authenticate, tenantScope, auditContext);

returnsRouter.get('/sales-returns', authorize('RETURN_READ'), validate(schema.listQuerySchema, 'query'), controller.listSalesReturns);
returnsRouter.post('/sales-returns', authorize('RETURN_CREATE'), validate(schema.createSalesReturnSchema), controller.createSalesReturn);
returnsRouter.get('/sales-returns/:id', authorize('RETURN_READ'), controller.getSalesReturn);
returnsRouter.put('/sales-returns/:id/cancel', authorize('RETURN_MODIFY'), validate(schema.cancelSchema), controller.cancelSalesReturn);

returnsRouter.get('/purchase-returns', authorize('RETURN_READ'), validate(schema.listQuerySchema, 'query'), controller.listPurchaseReturns);
returnsRouter.post('/purchase-returns', authorize('RETURN_CREATE'), validate(schema.createPurchaseReturnSchema), controller.createPurchaseReturn);
returnsRouter.get('/purchase-returns/:id', authorize('RETURN_READ'), controller.getPurchaseReturn);
returnsRouter.put('/purchase-returns/:id/cancel', authorize('RETURN_MODIFY'), validate(schema.cancelSchema), controller.cancelPurchaseReturn);

returnsRouter.get('/credit-notes', authorize('FINANCE_ADJUSTMENT_READ'), validate(schema.listQuerySchema, 'query'), controller.listCreditNotes);
returnsRouter.post('/credit-notes', authorize('FINANCE_ADJUSTMENT_CREATE'), validate(schema.createCreditNoteSchema), controller.createCreditNote);
returnsRouter.get('/credit-notes/:id', authorize('FINANCE_ADJUSTMENT_READ'), controller.getCreditNote);
returnsRouter.put('/credit-notes/:id/cancel', authorize('FINANCE_ADJUSTMENT_MODIFY'), validate(schema.cancelSchema), controller.cancelCreditNote);

returnsRouter.get('/debit-notes', authorize('FINANCE_ADJUSTMENT_READ'), validate(schema.listQuerySchema, 'query'), controller.listDebitNotes);
returnsRouter.post('/debit-notes', authorize('FINANCE_ADJUSTMENT_CREATE'), validate(schema.createDebitNoteSchema), controller.createDebitNote);
returnsRouter.get('/debit-notes/:id', authorize('FINANCE_ADJUSTMENT_READ'), controller.getDebitNote);
returnsRouter.put('/debit-notes/:id/cancel', authorize('FINANCE_ADJUSTMENT_MODIFY'), validate(schema.cancelSchema), controller.cancelDebitNote);

module.exports = { returnsRouter };
