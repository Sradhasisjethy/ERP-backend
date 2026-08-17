const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./production.controller');
const schema = require('./production.schema');

const productionRouter = Router();

productionRouter.use(authenticate, tenantScope, auditContext);

productionRouter.post('/plans/generate', authorize('PRODUCTION_CREATE'), validate(schema.generateProposalSchema), controller.generateProposal);
productionRouter.get('/plans', authorize('PRODUCTION_READ'), validate(schema.listQuerySchema, 'query'), controller.listPlans);
productionRouter.get('/plans/:id', authorize('PRODUCTION_READ'), controller.getPlan);
productionRouter.put('/plans/:id/confirm', authorize('PRODUCTION_MODIFY'), validate(schema.confirmPlanSchema), controller.confirmPlan);

productionRouter.get('/entries', authorize('PRODUCTION_READ'), validate(schema.listQuerySchema, 'query'), controller.listEntries);
productionRouter.post('/entries', authorize('PRODUCTION_CREATE'), validate(schema.createEntrySchema), controller.createEntry);
productionRouter.get('/entries/:id', authorize('PRODUCTION_READ'), controller.getEntry);

productionRouter.get('/pending-approvals', authorize('PRODUCTION_READ'), validate(schema.listQuerySchema, 'query'), controller.listPendingApprovals);
productionRouter.put('/consumptions/:id/approve', authorize('PRODUCTION_APPROVE_VARIANCE'), controller.approveVariance);

productionRouter.get('/wastage', authorize('WASTAGE_READ'), validate(schema.listQuerySchema, 'query'), controller.listWastage);
productionRouter.post('/wastage', authorize('WASTAGE_CREATE'), validate(schema.createWastageSchema), controller.createWastage);

module.exports = { productionRouter };
