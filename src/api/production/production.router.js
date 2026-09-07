const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { enforceFactoryScope } = require('../../middlewares/factoryScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./production.controller');
const schema = require('./production.schema');

const productionRouter = Router();

// BR-29: refuse any request naming a factory this user cannot access.
productionRouter.use(authenticate, tenantScope, auditContext, enforceFactoryScope);

productionRouter.post('/plans/generate', authorize('PRODUCTION_CREATE'), validate(schema.generateProposalSchema), controller.generateProposal);
productionRouter.get('/plans', authorize('PRODUCTION_READ'), validate(schema.listQuerySchema, 'query'), controller.listPlans);
productionRouter.get('/plans/:id', authorize('PRODUCTION_READ'), controller.getPlan);
// The shop-floor job card. Read-only, and carries no rates — see the renderer.
productionRouter.get('/plans/:id/sheet', authorize('PRODUCTION_READ'), controller.printSheet);
productionRouter.put('/plans/:id/confirm', authorize('PRODUCTION_MODIFY'), validate(schema.confirmPlanSchema), controller.confirmPlan);

productionRouter.get('/entries', authorize('PRODUCTION_READ'), validate(schema.listQuerySchema, 'query'), controller.listEntries);
productionRouter.post('/entries', authorize('PRODUCTION_CREATE'), validate(schema.createEntrySchema), controller.createEntry);
productionRouter.get('/entries/:id', authorize('PRODUCTION_READ'), controller.getEntry);
// A casting run moves stock twice (raw material out, finished goods in), so
// reversing one is a destructive operation: gated on PRODUCTION_DELETE, the
// same way a goods receipt cancellation is gated on PURCHASE_DELETE.
productionRouter.put('/entries/:id/cancel', authorize('PRODUCTION_DELETE'), validate(schema.cancelEntrySchema), controller.cancelEntry);

// Confirmed plan lines with how much of each has actually been cast. Declared
// before the parameterised entry routes so neither shadows the other.
productionRouter.get('/orders', authorize('PRODUCTION_READ'), validate(schema.listQuerySchema, 'query'), controller.listOrders);
productionRouter.get('/consumptions', authorize('PRODUCTION_READ'), validate(schema.listQuerySchema, 'query'), controller.listConsumptions);

productionRouter.get('/pending-approvals', authorize('PRODUCTION_READ'), validate(schema.listQuerySchema, 'query'), controller.listPendingApprovals);
productionRouter.put('/consumptions/:id/approve', authorize('PRODUCTION_APPROVE_VARIANCE'), controller.approveVariance);

productionRouter.get('/wastage', authorize('WASTAGE_READ'), validate(schema.listQuerySchema, 'query'), controller.listWastage);
productionRouter.post('/wastage', authorize('WASTAGE_CREATE'), validate(schema.createWastageSchema), controller.createWastage);

module.exports = { productionRouter };
