const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { enforceFactoryScope } = require('../../middlewares/factoryScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./analytics.controller');
const schema = require('./analytics.schema');

const analyticsRouter = Router();

// BR-29: refuse any request naming a factory this user cannot access.
analyticsRouter.use(authenticate, tenantScope, auditContext, enforceFactoryScope);

analyticsRouter.get('/stock-ageing', authorize('ANALYTICS_READ'), validate(schema.stockAgeingQuerySchema, 'query'), controller.getStockAgeing);
analyticsRouter.get('/dashboard', authorize('ANALYTICS_READ'), validate(schema.dashboardQuerySchema, 'query'), controller.getDashboardKpis);
analyticsRouter.get('/costing', authorize('ANALYTICS_READ'), validate(schema.costingQuerySchema, 'query'), controller.getCostingReport);
analyticsRouter.get('/alerts', authorize('ANALYTICS_READ'), validate(schema.alertsQuerySchema, 'query'), controller.getAlerts);
analyticsRouter.get('/cancellations', authorize('ANALYTICS_READ'), validate(schema.cancellationQuerySchema, 'query'), controller.getCancellationAnalytics);
analyticsRouter.get('/search', authorize('ANALYTICS_READ'), validate(schema.searchQuerySchema, 'query'), controller.searchDocuments);

module.exports = { analyticsRouter };
