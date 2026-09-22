const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { enforceFactoryScope } = require('../../middlewares/factoryScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./quotations.controller');
const schema = require('./quotations.schema');

const quotationsRouter = Router();

quotationsRouter.use(authenticate, tenantScope, auditContext, enforceFactoryScope);

quotationsRouter.get('/', authorize('QUOTATION_READ'), validate(schema.listQuerySchema, 'query'), controller.list);
quotationsRouter.post('/', authorize('QUOTATION_CREATE'), validate(schema.createQuotationSchema), controller.create);
quotationsRouter.get('/:id', authorize('QUOTATION_READ'), controller.get);
quotationsRouter.put('/:id', authorize('QUOTATION_MODIFY'), validate(schema.updateQuotationSchema), controller.update);
quotationsRouter.put('/:id/status', authorize('QUOTATION_MODIFY'), validate(schema.statusSchema), controller.setStatus);
// Raising the order is a sales-order act, so it needs that grant too.
quotationsRouter.post('/:id/convert', authorize('QUOTATION_MODIFY'), authorize('SALES_CREATE'), validate(schema.convertSchema), controller.convert);

module.exports = { quotationsRouter };
