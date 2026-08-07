const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
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
organizationRouter.use(authenticate, tenantScope);

// Organizations
organizationRouter.get('/organizations', authorize('ORG_READ'), validate(listQuerySchema, 'query'), listOrganizations);
organizationRouter.post('/organizations', authorize('ORG_WRITE'), validate(createOrganizationSchema), createOrganization);
organizationRouter.get('/organizations/:id', authorize('ORG_READ'), getOrganization);
organizationRouter.put('/organizations/:id', authorize('ORG_WRITE'), validate(updateOrganizationSchema), updateOrganization);
organizationRouter.delete('/organizations/:id', authorize('ORG_WRITE'), deleteOrganization);

// Offices
organizationRouter.get('/offices', authorize('ORG_READ'), validate(listQuerySchema, 'query'), listOffices);
organizationRouter.post('/offices', authorize('ORG_WRITE'), validate(createOfficeSchema), createOffice);
organizationRouter.get('/offices/:id', authorize('ORG_READ'), getOffice);
organizationRouter.put('/offices/:id', authorize('ORG_WRITE'), validate(updateOfficeSchema), updateOffice);
organizationRouter.delete('/offices/:id', authorize('ORG_WRITE'), deleteOffice);

// Departments
organizationRouter.get('/departments', authorize('ORG_READ'), validate(listQuerySchema, 'query'), listDepartments);
organizationRouter.post('/departments', authorize('ORG_WRITE'), validate(createDepartmentSchema), createDepartment);
organizationRouter.get('/departments/:id', authorize('ORG_READ'), getDepartment);
organizationRouter.put('/departments/:id', authorize('ORG_WRITE'), validate(updateDepartmentSchema), updateDepartment);
organizationRouter.delete('/departments/:id', authorize('ORG_WRITE'), deleteDepartment);

module.exports = { organizationRouter };
