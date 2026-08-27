const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { enforceFactoryScope } = require('../../middlewares/factoryScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./quality.controller');
const schema = require('./quality.schema');

const qualityRouter = Router();

// BR-29: refuse any request naming a factory this user cannot access.
qualityRouter.use(authenticate, tenantScope, auditContext, enforceFactoryScope);

// Declared before '/:id' so Express does not read 'held-lots' as an id.
qualityRouter.get('/held-lots', authorize('QUALITY_READ'), validate(schema.listQuerySchema, 'query'), controller.listHeldLots);

qualityRouter.get('/', authorize('QUALITY_READ'), validate(schema.listQuerySchema, 'query'), controller.listInspections);
qualityRouter.post('/', authorize('QUALITY_CREATE'), validate(schema.createInspectionSchema), controller.createInspection);
qualityRouter.get('/:id', authorize('QUALITY_READ'), controller.getInspection);

// Recording a verdict releases or quarantines stock, so it is a modify action
// rather than a read — and deliberately separate from raising the inspection.
qualityRouter.put('/:id/result', authorize('QUALITY_MODIFY'), validate(schema.recordResultSchema), controller.recordResult);

module.exports = { qualityRouter };
