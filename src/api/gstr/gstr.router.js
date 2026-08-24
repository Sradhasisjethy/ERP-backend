const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { enforceFactoryScope } = require('../../middlewares/factoryScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./gstr.controller');
const schema = require('./gstr.schema');

const gstrRouter = Router();

// BR-29: refuse any request naming a factory this user cannot access.
gstrRouter.use(authenticate, tenantScope, auditContext, enforceFactoryScope);

gstrRouter.get('/gstr1', authorize('GSTR_READ'), validate(schema.gstrQuerySchema, 'query'), controller.getGstr1);
gstrRouter.get('/gstr3b', authorize('GSTR_READ'), validate(schema.gstrQuerySchema, 'query'), controller.getGstr3b);

module.exports = { gstrRouter };
