const { Router } = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { list, getById, create, update, deleteUser, uploadDocument, listDocuments, deleteDocument, verifyDocument } = require('./user.controller');

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const employeeId = req.params.id;
    const dir = path.join(__dirname, '../../../uploads/employees', employeeId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueSuffix + '-' + file.originalname);
  }
});
const upload = multer({ storage: storage });
const { authenticate } = require('../../middlewares/auth');
const { authorize } = require('../../middlewares/authorize');
const { tenantScope } = require('../../middlewares/tenantScope');
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

const allowSelfOr = (permission) => {
  return (req, res, next) => {
    if (req.user && req.user.userId === req.params.id) {
      return next();
    }
    return authorize(permission)(req, res, next);
  };
};

router.post('/:id/documents', allowSelfOr(WebPermissions.EMPLOYEE_WRITE), upload.single('document'), uploadDocument);
router.get('/:id/documents', allowSelfOr(WebPermissions.EMPLOYEE_READ), listDocuments);
router.delete('/:id/documents/:documentId', allowSelfOr(WebPermissions.EMPLOYEE_WRITE), deleteDocument);
router.patch('/:id/documents/:documentId/verify', authorize(WebPermissions.EMPLOYEE_WRITE), verifyDocument);

module.exports = { userRouter: router };
