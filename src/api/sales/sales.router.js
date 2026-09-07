const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const {
  listSalesOrders, getSalesOrder, createSalesOrder, updateSalesOrder, markInProduction,
  confirmSalesOrder, cancelSalesOrder, shortCloseSalesOrder, getAvailableToPromise,
} = require('./sales.controller');
const {
  createSalesOrderSchema, updateSalesOrderSchema, reasonSchema, atpQuerySchema, listQuerySchema,
  addLineSchema, changeQuantitySchema, suppressSchema, restoreSchema, addComponentSchema,
} = require('./sales.schema');
const bundleCommands = require('../bundles/bundleCommands.controller');
const { idempotency } = require('../../middlewares/idempotency');

const salesRouter = Router();

salesRouter.use(authenticate, tenantScope, auditContext);

salesRouter.get('/atp', authorize('SALES_READ'), validate(atpQuerySchema, 'query'), getAvailableToPromise);

salesRouter.get('/orders', authorize('SALES_READ'), validate(listQuerySchema, 'query'), listSalesOrders);
salesRouter.post('/orders', authorize('SALES_CREATE'), validate(createSalesOrderSchema), createSalesOrder);
salesRouter.get('/orders/:id', authorize('SALES_READ'), getSalesOrder);
salesRouter.put('/orders/:id', authorize('SALES_MODIFY'), validate(updateSalesOrderSchema), updateSalesOrder);
salesRouter.put('/orders/:id/in-production', authorize('SALES_MODIFY'), markInProduction);
salesRouter.put('/orders/:id/confirm', authorize('SALES_MODIFY'), confirmSalesOrder);
salesRouter.put('/orders/:id/cancel', authorize('SALES_MODIFY'), validate(reasonSchema), cancelSalesOrder);
salesRouter.put('/orders/:id/short-close', authorize('SALES_MODIFY'), validate(reasonSchema), shortCloseSalesOrder);

// ---- bundle commands (docs/specs/bundle-kitting.md §6) --------------------
//
// Commands rather than a generic line PATCH: the orchestration stays on the
// server, so the frontend never becomes a second place where expansion rules
// live. Each one is replay-safe — a salesperson on a bad connection taps "add"
// twice and gets one printer, not two.

salesRouter.post('/orders/:id/lines', authorize('SALES_MODIFY'), idempotency(), validate(addLineSchema), bundleCommands.addLine);
salesRouter.patch('/orders/:id/lines/:lineId/quantity', authorize('SALES_MODIFY'), idempotency(), validate(changeQuantitySchema), bundleCommands.changeQuantity);
salesRouter.post('/orders/:id/lines/:lineId/suppress', authorize('SALES_MODIFY'), idempotency(), validate(suppressSchema), bundleCommands.suppress);
salesRouter.post('/orders/:id/lines/:parentLineId/restore', authorize('SALES_MODIFY'), idempotency(), validate(restoreSchema), bundleCommands.restore);
salesRouter.post('/orders/:id/lines/:parentLineId/components', authorize('SALES_MODIFY'), idempotency(), validate(addComponentSchema), bundleCommands.addComponent);
salesRouter.post('/orders/:id/lines/:lineId/reset', authorize('SALES_MODIFY'), idempotency(), bundleCommands.resetLine);
salesRouter.delete('/orders/:id/lines/:lineId', authorize('SALES_MODIFY'), idempotency(), bundleCommands.deleteLine);

salesRouter.get('/orders/:id/lines/:parentLineId/available-accessories', authorize('SALES_READ'), bundleCommands.availableAccessories);

module.exports = { salesRouter };
