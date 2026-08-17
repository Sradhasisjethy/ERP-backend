const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { listAuditLogs } = require('./auditLog.controller');
const { listQuerySchema } = require('./auditLog.schema');

const auditLogRouter = Router();

auditLogRouter.use(authenticate, tenantScope, auditContext);

// Read-only by design — audit rows are never created directly through the API,
// only as a side effect of BaseAuditedModel hooks (BR-30, BR-33).
auditLogRouter.get('/', authorize('AUDIT_READ'), validate(listQuerySchema, 'query'), listAuditLogs);

module.exports = { auditLogRouter };
