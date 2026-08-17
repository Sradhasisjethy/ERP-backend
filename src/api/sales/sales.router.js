const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const {
  listSalesOrders, getSalesOrder, createSalesOrder, confirmSalesOrder, cancelSalesOrder, shortCloseSalesOrder, getAvailableToPromise,
} = require('./sales.controller');
const { createSalesOrderSchema, reasonSchema, atpQuerySchema, listQuerySchema } = require('./sales.schema');

const salesRouter = Router();

salesRouter.use(authenticate, tenantScope, auditContext);

salesRouter.get('/atp', authorize('SALES_READ'), validate(atpQuerySchema, 'query'), getAvailableToPromise);

salesRouter.get('/orders', authorize('SALES_READ'), validate(listQuerySchema, 'query'), listSalesOrders);
salesRouter.post('/orders', authorize('SALES_CREATE'), validate(createSalesOrderSchema), createSalesOrder);
salesRouter.get('/orders/:id', authorize('SALES_READ'), getSalesOrder);
salesRouter.put('/orders/:id/confirm', authorize('SALES_MODIFY'), confirmSalesOrder);
salesRouter.put('/orders/:id/cancel', authorize('SALES_MODIFY'), validate(reasonSchema), cancelSalesOrder);
salesRouter.put('/orders/:id/short-close', authorize('SALES_MODIFY'), validate(reasonSchema), shortCloseSalesOrder);

module.exports = { salesRouter };
