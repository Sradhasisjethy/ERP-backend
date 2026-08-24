const { Router } = require('express');
const { list, getById, create, update, deleteUser } = require('./user.controller');
const { authenticate } = require('../../middlewares/auth');
const { authorize } = require('../../middlewares/authorize');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { validate } = require('../../middlewares/validate');
const { createUserSchema, updateUserSchema, listUsersQuerySchema } = require('./user.schema');
const { WebPermissions } = require('../../utils/constants');

const router = Router();

router.use(authenticate);
router.use(tenantScope);

router.get('/', authorize(WebPermissions.EMPLOYEE_READ), validate(listUsersQuerySchema), list);
router.get('/:id', authorize(WebPermissions.EMPLOYEE_READ), getById);
router.post('/', authorize(WebPermissions.EMPLOYEE_WRITE), validate(createUserSchema), create);
router.put('/:id', authorize(WebPermissions.EMPLOYEE_WRITE), validate(updateUserSchema), update);
router.delete('/:id', authorize(WebPermissions.EMPLOYEE_WRITE), deleteUser);

module.exports = { userRouter: router };
