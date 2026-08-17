const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./reports.controller');
const schema = require('./reports.schema');

const reportsRouter = Router();

reportsRouter.use(authenticate, tenantScope, auditContext);

/**
 * Route order matters here. `/catalog` and the saved-report collection routes
 * are single-segment paths that `GET /:id` would otherwise swallow, and the
 * two-segment catalog routes must not be mistaken for `/:id/...`. Literal
 * paths are therefore registered before parameterised ones, and the catalog's
 * two-segment shape (`/sales/summary`) keeps it unambiguous against the
 * saved-report API's one-segment `/:id`.
 *
 * There is no blanket `authorize()` on the catalog routes: the permission
 * depends on which report was requested, so the check happens in the
 * controller once the definition is resolved (see resolveReport).
 */
reportsRouter.get('/catalog', controller.catalog);

// --- Saved reports (M40) ---------------------------------------------------
reportsRouter.get('/', authorize('REPORT_READ'), validate(schema.listQuerySchema, 'query'), controller.list);
reportsRouter.post('/', authorize('REPORT_CREATE'), validate(schema.createReportSchema), controller.create);
reportsRouter.post('/run', authorize('REPORT_READ'), validate(schema.runReportSchema), controller.run);
// FR-M27-2: CSV/PDF carrying the company header and applied filters. Money
// columns are dropped entirely for users without VIEW_RATES (FR-M27-3).
reportsRouter.post('/export', authorize('REPORT_READ'), validate(schema.exportReportSchema), controller.exportReport);

// --- Catalog reports -------------------------------------------------------
// GET /api/v1/reports/:category/:report          one page + summary
// GET /api/v1/reports/:category/:report/meta     the definition alone
// GET /api/v1/reports/:category/:report/export   the whole filtered set as a file
reportsRouter.get(
  '/:category/:report/meta',
  validate(schema.reportParamsSchema, 'params'),
  controller.meta
);
reportsRouter.get(
  '/:category/:report/export',
  validate(schema.reportParamsSchema, 'params'),
  validate(schema.exportQuerySchema, 'query'),
  controller.exportCatalogReport
);
reportsRouter.get(
  '/:category/:report',
  validate(schema.reportParamsSchema, 'params'),
  validate(schema.reportQuerySchema, 'query'),
  controller.data
);

// --- Saved reports by id ---------------------------------------------------
reportsRouter.get('/:id', authorize('REPORT_READ'), controller.get);
reportsRouter.delete('/:id', authorize('REPORT_DELETE'), controller.remove);
reportsRouter.post('/:id/run', authorize('REPORT_READ'), validate(schema.runSavedReportSchema), controller.runSaved);

module.exports = { reportsRouter };
