const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { enforceFactoryScope } = require('../../middlewares/factoryScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./cashRegister.controller');
const schema = require('./cashRegister.schema');

const cashRegisterRouter = Router();

cashRegisterRouter.use(authenticate, tenantScope, auditContext, enforceFactoryScope);

// Fixed paths before /:id.
cashRegisterRouter.get('/denominations', authorize('CASH_REGISTER_READ'), controller.denominations);
cashRegisterRouter.get('/sessions/current', authorize('CASH_REGISTER_READ'), validate(schema.currentQuerySchema, 'query'), controller.current);
cashRegisterRouter.get('/sessions', authorize('CASH_REGISTER_READ'), validate(schema.listQuerySchema, 'query'), controller.list);
cashRegisterRouter.post('/sessions', authorize('CASH_REGISTER_CREATE'), validate(schema.openSessionSchema), controller.open);
cashRegisterRouter.get('/sessions/:id', authorize('CASH_REGISTER_READ'), controller.get);
cashRegisterRouter.put('/sessions/:id/close', authorize('CASH_REGISTER_MODIFY'), validate(schema.closeSessionSchema), controller.close);

module.exports = { cashRegisterRouter };
