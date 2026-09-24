const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { listCounterSales, getCounterSale, createCounterSale, quoteCounterSale, cancelCounterSale } = require('./retail.controller');
const { createCounterSaleSchema, quoteCounterSaleSchema, listQuerySchema, cancelCounterSaleSchema } = require('./retail.schema');

const retailRouter = Router();

retailRouter.use(authenticate, tenantScope, auditContext);

/**
 * Gated on INVOICE_* rather than a new RETAIL_* resource: a counter sale is a
 * sales invoice raised by a different process, and anyone permitted to bill a
 * customer is permitted to bill one standing at the counter. Inventing a
 * parallel permission would mean every existing role silently losing access to
 * a screen it should already have.
 *
 * The extra grant a counter sale may need — PAYMENT_CREATE, when money is
 * collected in the same step — is checked in the controller, because it depends
 * on the request body rather than the route.
 */
retailRouter.get('/counter-sales', authorize('INVOICE_READ'), validate(listQuerySchema, 'query'), listCounterSales);
retailRouter.post('/counter-sales', authorize('INVOICE_CREATE'), validate(createCounterSaleSchema), createCounterSale);
// Registered before '/counter-sales/:id' so the literal path is not swallowed
// by the parameter route and treated as an invoice id.
retailRouter.post('/counter-sales/quote', authorize('INVOICE_READ'), validate(quoteCounterSaleSchema), quoteCounterSale);
retailRouter.get('/counter-sales/:id', authorize('INVOICE_READ'), getCounterSale);
// Reverses the sale and the money it took, together. Gated on the same
// permission as cancelling any other invoice; PAYMENT_MODIFY is not demanded
// on top, because the payment being reversed is part of the sale rather than a
// separate act the counter chose to take.
retailRouter.post('/counter-sales/:id/cancel', authorize('INVOICE_MODIFY'), validate(cancelCounterSaleSchema), cancelCounterSale);

module.exports = { retailRouter };
