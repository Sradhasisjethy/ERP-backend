const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { enforceFactoryScope } = require('../../middlewares/factoryScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./workforce.controller');
const schema = require('./workforce.schema');

const workforceRouter = Router();

// BR-29: refuse any request naming a factory this user cannot access.
workforceRouter.use(authenticate, tenantScope, auditContext, enforceFactoryScope);

workforceRouter.get('/contractor/material-issues', authorize('CONTRACTOR_READ'), validate(schema.listQuerySchema, 'query'), controller.listMaterialIssues);
workforceRouter.post('/contractor/material-issues', authorize('CONTRACTOR_CREATE'), validate(schema.issueMaterialSchema), controller.issueMaterial);
workforceRouter.get('/contractor/material-issues/:id', authorize('CONTRACTOR_READ'), controller.getMaterialIssue);

workforceRouter.get('/contractor/production-entries', authorize('CONTRACTOR_READ'), validate(schema.listQuerySchema, 'query'), controller.listContractorEntries);
workforceRouter.post('/contractor/production-entries', authorize('CONTRACTOR_CREATE'), validate(schema.createContractorEntrySchema), controller.createContractorEntry);
workforceRouter.get('/contractor/production-entries/:id', authorize('CONTRACTOR_READ'), controller.getContractorEntry);

workforceRouter.get('/labour/attendance', authorize('LABOUR_READ'), validate(schema.listQuerySchema, 'query'), controller.listAttendance);
workforceRouter.post('/labour/attendance', authorize('LABOUR_CREATE'), validate(schema.markAttendanceSchema), controller.markAttendance);

workforceRouter.get('/advances', authorize('LABOUR_READ'), validate(schema.listQuerySchema, 'query'), controller.listAdvances);
workforceRouter.post('/advances', authorize('LABOUR_CREATE'), validate(schema.createAdvanceSchema), controller.createAdvance);
workforceRouter.put('/advances/:id/cancel', authorize('LABOUR_MODIFY'), validate(schema.cancelSchema), controller.cancelAdvance);

module.exports = { workforceRouter };
