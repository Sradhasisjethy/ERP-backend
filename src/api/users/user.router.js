const { Router } = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { list, getById, create, update, deleteUser, uploadDocument, listDocuments, downloadDocument, deleteDocument, verifyDocument, uploadAvatar } = require('./user.controller');

/**
 * Anything a browser will execute if it ever renders the file. Documents are
 * served as attachments now, but the safe list is kept narrow rather than
 * relying on one header: an employee document is an ID scan, a contract or a
 * certificate, and none of those are HTML.
 */
const DOCUMENT_MIME_ALLOW_LIST = [
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
];

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // `req.params.id` is URL-decoded by Express, so it reaches this callback
    // able to contain `../`. It is joined straight onto a filesystem path and
    // then mkdir'd, which made an upload an arbitrary-directory write for
    // anyone holding the document-write grant. Refuse anything that is not the
    // UUID this route is documented to take.
    const employeeId = req.params.id;
    if (!/^[0-9a-fA-F-]{36}$/.test(employeeId)) {
      return cb(new Error('Invalid employee id'));
    }
    const dir = path.join(__dirname, '../../../uploads/employees', employeeId);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    // The original name is the user's, so it must not steer the path either.
    const safeName = path.basename(file.originalname).replace(/[^\w.\- ]/g, '_');
    cb(null, uniqueSuffix + '-' + safeName);
  }
});
const upload = multer({
  storage: storage,
  // Previously unbounded in both dimensions: any authenticated user could fill
  // the disk, and could store a .html or .svg that the old static mount served
  // as executable script from the API's own origin.
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (DOCUMENT_MIME_ALLOW_LIST.includes(file.mimetype)) return cb(null, true);
    cb(new Error('Unsupported document type. Upload a PDF, image, Word or Excel file.'));
  },
});

const avatarStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(__dirname, '../../../uploads/avatars');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    const ext = path.extname(file.originalname) || '.png';
    cb(null, 'avatar-' + uniqueSuffix + ext);
  }
});
const uploadAvatarMulter = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024 }, // 2 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are allowed (JPEG, PNG, WEBP)'));
    }
  }
});

const { authenticate } = require('../../middlewares/auth');
const { authorize } = require('../../middlewares/authorize');
const { tenantScope } = require('../../middlewares/tenantScope');
const { validate } = require('../../middlewares/validate');
const { createUserSchema, updateUserSchema, listUsersQuerySchema } = require('./user.schema');
const { WebPermissions } = require('../../utils/constants');

const router = Router();

router.use(authenticate);
router.use(tenantScope);

/**
 * These guards asked for the legacy `EMPLOYEE_WRITE` until now, which no user
 * could ever satisfy: expandPermissions consumes a `_WRITE` alias and emits the
 * granular codes in its place, never the alias itself, while holdsPermission
 * compares exactly. So every write route here answered 403 to HR_ADMIN,
 * ORG_ADMIN and every AdGroup alike, and user administration was reachable only
 * by the two bypass roles. See the reachability assertion in tests/rbac.test.js.
 */
router.get('/', authorize(WebPermissions.EMPLOYEE_READ), validate(listUsersQuerySchema), list);
// Setting your own picture is self-service, not user administration — gating it
// on an admin grant left ordinary staff unable to use their own profile page.
router.post('/avatar', uploadAvatarMulter.single('avatar'), uploadAvatar);
router.get('/:id', authorize(WebPermissions.EMPLOYEE_READ), getById);
router.post('/', authorize(WebPermissions.EMPLOYEE_CREATE), validate(createUserSchema), create);
router.put('/:id', authorize(WebPermissions.EMPLOYEE_MODIFY), validate(updateUserSchema), update);
router.delete('/:id', authorize(WebPermissions.EMPLOYEE_DELETE), deleteUser);

const allowSelfOr = (permission) => {
  return (req, res, next) => {
    if (req.user && req.user.userId === req.params.id) {
      return next();
    }
    return authorize(permission)(req, res, next);
  };
};

router.post('/:id/documents', allowSelfOr(WebPermissions.EMPLOYEE_MODIFY), upload.single('document'), uploadDocument);
router.get('/:id/documents', allowSelfOr(WebPermissions.EMPLOYEE_READ), listDocuments);
// The bytes behind the list. Same gate as the list itself — before this existed
// the files were served by an unauthenticated express.static mount.
router.get('/:id/documents/:documentId/file', allowSelfOr(WebPermissions.EMPLOYEE_READ), downloadDocument);
router.delete('/:id/documents/:documentId', allowSelfOr(WebPermissions.EMPLOYEE_MODIFY), deleteDocument);
// Deliberately not allowSelfOr: verifying your own document defeats the point.
router.patch('/:id/documents/:documentId/verify', authorize(WebPermissions.EMPLOYEE_MODIFY), verifyDocument);

module.exports = { userRouter: router };
