const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const {
  listOrganizations,
  getOrganization,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  listOffices,
  getOffice,
  createOffice,
  updateOffice,
  deleteOffice,
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  deleteDepartment,
} = require('./organization.controller');
const {
  createOrganizationSchema,
  updateOrganizationSchema,
  createOfficeSchema,
  updateOfficeSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
  listQuerySchema,
} = require('./organization.schema');

const organizationRouter = Router();

// Apply global middlewares
// auditContext must follow tenantScope — it writes into the CLS session
// tenantScope opens, and without it BR-30 rows carry a null user.
organizationRouter.use(authenticate, tenantScope, auditContext);

// Organizations
organizationRouter.get('/organizations', authorize('ORG_READ'), validate(listQuerySchema, 'query'), listOrganizations);
organizationRouter.post('/organizations', authorize('ORG_CREATE'), validate(createOrganizationSchema), createOrganization);
organizationRouter.get('/organizations/:id', authorize('ORG_READ'), getOrganization);
organizationRouter.put('/organizations/:id', authorize('ORG_MODIFY'), validate(updateOrganizationSchema), updateOrganization);
organizationRouter.delete('/organizations/:id', authorize('ORG_DELETE'), deleteOrganization);

// Offices
organizationRouter.get('/offices', authorize('ORG_READ'), validate(listQuerySchema, 'query'), listOffices);
organizationRouter.post('/offices', authorize('ORG_CREATE'), validate(createOfficeSchema), createOffice);
organizationRouter.get('/offices/:id', authorize('ORG_READ'), getOffice);
organizationRouter.put('/offices/:id', authorize('ORG_MODIFY'), validate(updateOfficeSchema), updateOffice);
organizationRouter.delete('/offices/:id', authorize('ORG_DELETE'), deleteOffice);

// Departments
organizationRouter.get('/departments', authorize('ORG_READ'), validate(listQuerySchema, 'query'), listDepartments);
organizationRouter.post('/departments', authorize('ORG_CREATE'), validate(createDepartmentSchema), createDepartment);
organizationRouter.get('/departments/:id', authorize('ORG_READ'), getDepartment);
organizationRouter.put('/departments/:id', authorize('ORG_MODIFY'), validate(updateDepartmentSchema), updateDepartment);
organizationRouter.delete('/departments/:id', authorize('ORG_DELETE'), deleteDepartment);

module.exports = { organizationRouter };
