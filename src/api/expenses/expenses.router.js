const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./expenses.controller');
const schema = require('./expenses.schema');

const expensesRouter = Router();

expensesRouter.use(authenticate, tenantScope, auditContext);

expensesRouter.get('/', authorize('EXPENSE_READ'), validate(schema.listQuerySchema, 'query'), controller.list);
expensesRouter.post('/', authorize('EXPENSE_CREATE'), validate(schema.createExpenseSchema), controller.createExpense);
expensesRouter.get('/:id', authorize('EXPENSE_READ'), controller.get);
expensesRouter.put('/:id/cancel', authorize('EXPENSE_MODIFY'), validate(schema.cancelSchema), controller.cancelExpense);

module.exports = { expensesRouter };
