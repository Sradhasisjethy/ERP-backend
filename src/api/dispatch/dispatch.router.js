const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { listChallans, getChallan, createChallan, cancelChallan, printChallan } = require('./dispatch.controller');
const { createChallanSchema, cancelChallanSchema, printQuerySchema, listQuerySchema } = require('./dispatch.schema');

const dispatchRouter = Router();

dispatchRouter.use(authenticate, tenantScope, auditContext);

dispatchRouter.get('/challans', authorize('DISPATCH_READ'), validate(listQuerySchema, 'query'), listChallans);
dispatchRouter.post('/challans', authorize('DISPATCH_CREATE'), validate(createChallanSchema), createChallan);
dispatchRouter.get('/challans/:id', authorize('DISPATCH_READ'), getChallan);
// Named grant: cancelling a challan puts stock back, which DISPATCH_MODIFY does not imply.
dispatchRouter.put('/challans/:id/cancel', authorize('DISPATCH_CANCEL'), validate(cancelChallanSchema), cancelChallan);
dispatchRouter.get('/challans/:id/print', authorize('DISPATCH_READ'), validate(printQuerySchema, 'query'), printChallan);

module.exports = { dispatchRouter };
