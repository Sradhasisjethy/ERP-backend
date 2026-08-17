const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { listInvoices, getInvoice, createInvoice, cancelInvoice } = require('./invoicing.controller');
const { createInvoiceSchema, cancelInvoiceSchema, listQuerySchema } = require('./invoicing.schema');

const invoicingRouter = Router();

invoicingRouter.use(authenticate, tenantScope, auditContext);

invoicingRouter.get('/', authorize('INVOICE_READ'), validate(listQuerySchema, 'query'), listInvoices);
invoicingRouter.post('/', authorize('INVOICE_CREATE'), validate(createInvoiceSchema), createInvoice);
invoicingRouter.get('/:id', authorize('INVOICE_READ'), getInvoice);
invoicingRouter.put('/:id/cancel', authorize('INVOICE_MODIFY'), validate(cancelInvoiceSchema), cancelInvoice);

module.exports = { invoicingRouter };
