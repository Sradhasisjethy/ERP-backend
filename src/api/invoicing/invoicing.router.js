const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { listInvoices, getInvoice, createInvoice, cancelInvoice, printInvoice } = require('./invoicing.controller');
const { createInvoiceSchema, cancelInvoiceSchema, listQuerySchema } = require('./invoicing.schema');

const invoicingRouter = Router();

invoicingRouter.use(authenticate, tenantScope, auditContext);

invoicingRouter.get('/', authorize('INVOICE_READ'), validate(listQuerySchema, 'query'), listInvoices);
invoicingRouter.post('/', authorize('INVOICE_CREATE'), validate(createInvoiceSchema), createInvoice);
invoicingRouter.get('/:id', authorize('INVOICE_READ'), getInvoice);
// Safe to register after '/:id': that route matches a single path segment, so
// it never captures '/:id/print'. Same shape as the challan print route.
invoicingRouter.get('/:id/print', authorize('INVOICE_READ'), printInvoice);
// A named grant, not INVOICE_MODIFY: reversing a posted invoice unwinds its
// stock and ledger postings, which edit rights should not carry with them.
invoicingRouter.put('/:id/cancel', authorize('INVOICE_CANCEL'), validate(cancelInvoiceSchema), cancelInvoice);

module.exports = { invoicingRouter };
