const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const {
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

roleRouter.use(authenticate, tenantScope);

roleRouter.get('/', authorize('ROLE_READ'), validate(listQuerySchema, 'query'), listRoles);
roleRouter.post('/', authorize('ROLE_WRITE'), validate(createRoleSchema), createRole);
roleRouter.get('/:id', authorize('ROLE_READ'), getRole);
roleRouter.put('/:id', authorize('ROLE_WRITE'), validate(updateRoleSchema), updateRole);
roleRouter.delete('/:id', authorize('ROLE_WRITE'), deleteRole);

roleRouter.get('/:id/members', authorize('ROLE_READ'), getMembers);
roleRouter.post('/:id/members', authorize('ROLE_WRITE'), validate(assignMemberSchema), assignMember);
roleRouter.delete('/:id/members/:employeeId', authorize('ROLE_WRITE'), removeMember);

module.exports = { roleRouter };
