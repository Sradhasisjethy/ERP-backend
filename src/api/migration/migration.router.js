const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./migration.controller');
const schema = require('./migration.schema');

const migrationRouter = Router();

migrationRouter.use(authenticate, tenantScope, auditContext);

// Migration writes opening stock and opening ledger balances, so it is gated
// on its own permission rather than reusing a module's write permission —
// this is a one-time, high-blast-radius operation.
migrationRouter.get('/templates', authorize('MIGRATION_RUN'), controller.templates);
migrationRouter.post('/validate', authorize('MIGRATION_RUN'), validate(schema.importSchema), controller.validateImport);
migrationRouter.post('/import', authorize('MIGRATION_RUN'), validate(schema.importSchema), controller.runImport);
migrationRouter.post('/reconcile', authorize('MIGRATION_RUN'), validate(schema.reconcileSchema), controller.reconcile);

module.exports = { migrationRouter };
