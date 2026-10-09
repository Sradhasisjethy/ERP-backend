const { Router } = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { AppError, ValidationError } = require('../../core/AppError');
const { getTenantContext } = require('../../core/tenantContext');
const { uploadLimiter } = require('../../middlewares/rateLimiter');
const { list, getById, create, update, deleteUser, uploadDocument, listDocuments, downloadDocument, deleteDocument, verifyDocument, uploadAvatar } = require('./user.controller');
const { DOCUMENT_TYPES, DOCUMENT_MIME_ALLOW_LIST, hasSignature, discardUpload } = require('./documentFiles');

/**
 * Every part of an upload request is bounded, not just the file. Without these
 * busboy accepts unlimited fields of up to 1 MB each, all buffered in memory.
 * The document form sends one file and `documentType` (at most 100 characters,
 * so 400 bytes of UTF-8); 1 KB per field and a handful of parts covers that
 * with room for whatever a client library adds.
 */
const PART_LIMITS = { files: 1, fields: 5, fieldSize: 1024, parts: 7 };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    // `req.params.id` is URL-decoded by Express, so it reaches this callback
    // able to contain `../`. It is joined straight onto a filesystem path and
    // then mkdir'd, which made an upload an arbitrary-directory write for
    // anyone holding the document-write grant. Refuse anything that is not the
    // UUID this route is documented to take — canonical shape only, so 36
    // dashes or a stray character cannot name a folder — and always in lower
    // case: Postgres matches the uppercase spelling of the same id, and the
    // download builds its path from the stored (lowercase) id, so an uppercase
    // folder would hold a file nothing could ever serve on a case-sensitive disk.
    if (!UUID.test(String(req.params.id))) {
      return cb(new ValidationError('Invalid employee id'));
    }
    const dir = path.join(__dirname, '../../../uploads/employees', req.params.id.toLowerCase());
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    // The client's name steers neither the path nor the extension: the type
    // decides the extension, and verifyDocumentBytes proves the type. The
    // sanitised original name is kept only as the display name in the row.
    cb(null, uniqueSuffix + DOCUMENT_TYPES[file.mimetype]);
  }
});

/**
 * Removes the employee folder a refused upload created, if it is still empty
 * (rmdir refuses one that is not). A too-big file is refused after the folder
 * exists, and that would otherwise leave an empty folder per attempt.
 */
const pruneEmployeeFolder = (req) => {
  if (!UUID.test(String(req.params.id))) return;
  fs.rmdir(path.join(__dirname, '../../../uploads/employees', req.params.id.toLowerCase()), () => {});
};
const upload = multer({
  storage: storage,
  // Previously unbounded in both dimensions: any authenticated user could fill
  // the disk, and could store a .html or .svg that the old static mount served
  // as executable script from the API's own origin.
  limits: { fileSize: 10 * 1024 * 1024, ...PART_LIMITS },
  // Browsers send the filename as raw UTF-8 without a charset parameter, and
  // multer's default (latin1) turned 'प्रमाण.pdf' into mojibake before the
  // display-name sanitiser ever saw it.
  defParamCharset: 'utf8',
  fileFilter: (req, file, cb) => {
    if (DOCUMENT_MIME_ALLOW_LIST.includes(file.mimetype)) return cb(null, true);
    cb(new ValidationError('Unsupported document type. Upload a PDF, image, Word or Excel file.'));
  },
});

/**
 * Avatars are served publicly, inline, from the API's own origin, so whatever
 * lands in uploads/avatars/ is something a browser will render there. The
 * filter used to accept any `image/*` the client claimed (including SVG, which
 * runs script) and kept the client's own extension, so `x.html` or `x.js` could
 * be planted next to the API. Now only three raster types are accepted, the
 * extension comes from the type rather than the filename, and the bytes are
 * checked after upload because the declared type is just a header.
 */
const AVATAR_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

const avatarStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(__dirname, '../../../uploads/avatars');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    // Avatars are served without authentication, so the name must not be
    // guessable: a timestamp plus Math.random is. A UUID still matches the
    // avatar-[\w-]+ pattern user.schema.js accepts.
    cb(null, 'avatar-' + randomUUID() + AVATAR_TYPES[file.mimetype]);
  }
});
const uploadAvatarMulter = multer({
  storage: avatarStorage,
  limits: { fileSize: 2 * 1024 * 1024, ...PART_LIMITS }, // 2 MB max
  fileFilter: (req, file, cb) => {
    if (AVATAR_TYPES[file.mimetype]) {
      cb(null, true);
    } else {
      cb(new ValidationError('Only JPEG, PNG or WEBP images are allowed'));
    }
  }
});

/**
 * Runs a multer middleware and turns its refusals into 400s.
 *
 * A limit breach arrives as a MulterError and used to fall through to the
 * error handler as a 500, so a too-big file looked like a server crash. Our own
 * filter and destination already throw ValidationError; anything else (a disk
 * error, say) is a real 500 and is passed on untouched. Same shape as
 * receiveFile in masterData.router.js. `onRefused` runs on any failure, after
 * multer has removed whatever partial file it wrote.
 */
const receive = (middleware, maxLabel, onRefused = () => {}) => (req, res, next) =>
  middleware(req, res, (error) => {
    if (error) onRefused(req);
    if (!error || error instanceof AppError) return next(error);
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return next(new ValidationError(`That file is larger than ${maxLabel}.`));
      return next(new ValidationError(`The upload was refused: ${error.message.toLowerCase()}.`));
    }
    return next(error);
  });

/**
 * Refuses a file whose bytes are not the type it was declared as, and deletes
 * it with `discard` — for a document that also removes the employee folder the
 * upload just created, if the refused file was all it held.
 */
const verifyBytes = (message, discard = (file) => fs.unlink(file.path, () => {})) => (req, res, next) => {
  if (!req.file) return next();
  let valid = false;
  try {
    valid = req.file.size > 0 && hasSignature(req.file.path, req.file.mimetype);
  } catch {
    valid = false;
  }
  if (!valid) {
    discard(req.file);
    return next(new ValidationError(req.file.size === 0 ? 'The file is empty.' : message));
  }
  next();
};

const verifyAvatarBytes = verifyBytes('The file is not a valid JPEG, PNG or WEBP image');
const verifyDocumentBytes = verifyBytes('The file does not match its type. Upload a real PDF, image, Word or Excel file.', discardUpload);

/**
 * Keeps the tenant context across multer.
 *
 * cls-hooked loses the context on a stream whose socket predates tenantScope's
 * `session.run()`, and multer reads the upload from `req`'s data events — so
 * every query after the upload ran with no tenant: unscoped reads, and inserts
 * that fail on a null tenantId. The master-data importer binds the emitters for
 * the same reason (masterData.router.js).
 */
const keepTenantContext = (req, res, next) => {
  const session = getTenantContext();
  if (session && session.active) {
    session.bindEmitter(req);
    session.bindEmitter(res);
  }
  next();
};

const { authenticate } = require('../../middlewares/auth');
const { authorize } = require('../../middlewares/authorize');
const { tenantScope } = require('../../middlewares/tenantScope');
const { validate } = require('../../middlewares/validate');
const { createUserSchema, updateUserSchema, listUsersQuerySchema, verifyDocumentSchema } = require('./user.schema');
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
router.post('/avatar', uploadLimiter, keepTenantContext, receive(uploadAvatarMulter.single('avatar'), '2 MB'), verifyAvatarBytes, uploadAvatar);
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

router.post('/:id/documents', allowSelfOr(WebPermissions.EMPLOYEE_MODIFY), uploadLimiter, keepTenantContext, receive(upload.single('document'), '10 MB', pruneEmployeeFolder), verifyDocumentBytes, uploadDocument);
// Someone else's documents (ID scans, offer letters) need an HR-level grant.
// EMPLOYEE_READ is the staff directory and is held by the default "Employee"
// role, so gating on it let every member of staff download every colleague's
// papers. Your own documents stay yours to read.
router.get('/:id/documents', allowSelfOr(WebPermissions.EMPLOYEE_MODIFY), listDocuments);
// The bytes behind the list. Same gate as the list itself — before this existed
// the files were served by an unauthenticated express.static mount.
router.get('/:id/documents/:documentId/file', allowSelfOr(WebPermissions.EMPLOYEE_MODIFY), downloadDocument);
// Self-delete covers unverified documents only: deleteDocument refuses a
// verified one for everybody, so HR's sign-off cannot be removed by its owner.
router.delete('/:id/documents/:documentId', allowSelfOr(WebPermissions.EMPLOYEE_MODIFY), deleteDocument);
// Deliberately not allowSelfOr: verifying your own document defeats the point.
router.patch('/:id/documents/:documentId/verify', authorize(WebPermissions.EMPLOYEE_MODIFY), validate(verifyDocumentSchema), verifyDocument);

module.exports = { userRouter: router };
