const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const {
  listFactories,
  getFactory,
  createFactory,
  updateFactory,
  deleteFactory,
  listFinancialYears,
  getCurrentFinancialYear,
  createFinancialYear,
  updateFinancialYear,
  updateFinancialYearStatus,
  getFinancialYearPeriods,
  getCloseChecklist,
  deleteFinancialYear,
  setCurrentFinancialYear,
  listAssignedUsers,
  assignUser,
  unassignUser,
} = require('./factory.controller');
const {
  createFactorySchema,
  updateFactorySchema,
  createFinancialYearSchema,
  updateFinancialYearSchema,
  updateFinancialYearStatusSchema,
  assignUserFactorySchema,
  listQuerySchema,
} = require('./factory.schema');

const factoryRouter = Router();

factoryRouter.use(authenticate, tenantScope, auditContext);

// Factories
factoryRouter.get('/factories', authorize('FACTORY_READ'), validate(listQuerySchema, 'query'), listFactories);
factoryRouter.post('/factories', authorize('FACTORY_CREATE'), validate(createFactorySchema), createFactory);
factoryRouter.get('/factories/:id', authorize('FACTORY_READ'), getFactory);
factoryRouter.put('/factories/:id', authorize('FACTORY_MODIFY'), validate(updateFactorySchema), updateFactory);
factoryRouter.delete('/factories/:id', authorize('FACTORY_DELETE'), deleteFactory);

factoryRouter.get('/factories/:id/users', authorize('FACTORY_READ'), listAssignedUsers);
factoryRouter.post('/factories/:id/users', authorize('FACTORY_CREATE'), validate(assignUserFactorySchema), assignUser);
factoryRouter.delete('/factories/:id/users/:userId', authorize('FACTORY_DELETE'), unassignUser);

// Financial Years
factoryRouter.get('/financial-years', authorize('FACTORY_READ'), listFinancialYears);
factoryRouter.get('/financial-years/current', authorize('FACTORY_READ'), getCurrentFinancialYear);
factoryRouter.get('/financial-years/:id/periods', authorize('FACTORY_READ'), getFinancialYearPeriods);
factoryRouter.get('/financial-years/:id/close-checklist', authorize('FACTORY_READ'), getCloseChecklist);
factoryRouter.post('/financial-years', authorize('FACTORY_CREATE'), validate(createFinancialYearSchema), createFinancialYear);
factoryRouter.put('/financial-years/:id', authorize('FACTORY_MODIFY'), validate(updateFinancialYearSchema), updateFinancialYear);
factoryRouter.patch('/financial-years/:id/status', authorize('FACTORY_MODIFY'), validate(updateFinancialYearStatusSchema), updateFinancialYearStatus);
factoryRouter.delete('/financial-years/:id', authorize('FACTORY_DELETE'), deleteFinancialYear);
factoryRouter.put('/financial-years/:id/set-current', authorize('FACTORY_MODIFY'), setCurrentFinancialYear);

module.exports = { factoryRouter };
