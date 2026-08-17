const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { listDocumentSeries } = require('./documentSeries.controller');
const { listQuerySchema } = require('./documentSeries.schema');

const documentSeriesRouter = Router();

documentSeriesRouter.use(authenticate, tenantScope, auditContext);

documentSeriesRouter.get('/', authorize('FACTORY_READ'), validate(listQuerySchema, 'query'), listDocumentSeries);

module.exports = { documentSeriesRouter };
