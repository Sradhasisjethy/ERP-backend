const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./crm.controller');
const schema = require('./crm.schema');

const crmRouter = Router();

crmRouter.use(authenticate, tenantScope, auditContext);

// Fixed paths before /leads/:id.
crmRouter.get('/lead-sources', authorize('LEAD_READ'), controller.sources);
crmRouter.get('/pipeline', authorize('LEAD_READ'), controller.pipeline);
crmRouter.get('/tasks', authorize('LEAD_READ'), validate(schema.taskQuerySchema, 'query'), controller.pendingTasks);
crmRouter.put('/activities/:id/complete', authorize('LEAD_MODIFY'), controller.completeActivity);

crmRouter.get('/leads', authorize('LEAD_READ'), validate(schema.listQuerySchema, 'query'), controller.list);
crmRouter.post('/leads', authorize('LEAD_CREATE'), validate(schema.createLeadSchema), controller.create);
crmRouter.get('/leads/:id', authorize('LEAD_READ'), controller.get);
crmRouter.put('/leads/:id', authorize('LEAD_MODIFY'), validate(schema.updateLeadSchema), controller.update);
crmRouter.put('/leads/:id/status', authorize('LEAD_MODIFY'), validate(schema.statusSchema), controller.setStatus);
// Converting creates a customer, so it needs that grant as well.
crmRouter.post('/leads/:id/convert', authorize('LEAD_MODIFY'), authorize('PARTY_CREATE'), validate(schema.convertSchema), controller.convert);
crmRouter.post('/leads/:id/activities', authorize('LEAD_MODIFY'), validate(schema.activitySchema), controller.addActivity);

module.exports = { crmRouter };
