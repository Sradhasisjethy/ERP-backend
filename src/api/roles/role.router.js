const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const {
  getPermissionCatalog,
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  getMembers,
  assignMember,
  removeMember,
} = require('./role.controller');
const {
  createRoleSchema,
  updateRoleSchema,
  assignMemberSchema,
  listQuerySchema,
} = require('./role.schema');

const roleRouter = Router();

// auditContext must follow tenantScope — BR-30 requires role and
// permission changes to name the user who made them.
roleRouter.use(authenticate, tenantScope, auditContext);

// Before '/:id' so the literal path isn't swallowed by the id route.
roleRouter.get('/permission-catalog', authorize('ROLE_READ'), getPermissionCatalog);

roleRouter.get('/', authorize('ROLE_READ'), validate(listQuerySchema, 'query'), listRoles);
roleRouter.post('/', authorize('ROLE_CREATE'), validate(createRoleSchema), createRole);
roleRouter.get('/:id', authorize('ROLE_READ'), getRole);
roleRouter.put('/:id', authorize('ROLE_MODIFY'), validate(updateRoleSchema), updateRole);
roleRouter.delete('/:id', authorize('ROLE_DELETE'), deleteRole);

roleRouter.get('/:id/members', authorize('ROLE_READ'), getMembers);
roleRouter.post('/:id/members', authorize('ROLE_CREATE'), validate(assignMemberSchema), assignMember);
roleRouter.delete('/:id/members/:employeeId', authorize('ROLE_DELETE'), removeMember);

module.exports = { roleRouter };
