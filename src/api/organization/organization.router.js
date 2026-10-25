const { Router } = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize, hasPermission } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { uploadLimiter } = require('../../middlewares/rateLimiter');
const { AppError, ValidationError, ForbiddenError } = require('../../core/AppError');
const { hasSignature } = require('../users/documentFiles');
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
  uploadLogo,
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

/**
 * Company logo upload — the avatar pipeline's rules, applied to the logos
 * directory (user.router.js spells out the reasoning): only three raster
 * types, the extension from the declared type never the filename, an
 * unguessable name, and the bytes checked after upload because the declared
 * type is just a header. Logos render on GST invoices, challans, BOM
 * printouts and POs, all served from this API's origin.
 */
const LOGO_TYPES = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};
const LOGO_PART_LIMITS = { files: 1, fields: 2, fieldSize: 1024, parts: 4 };

const logoStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = path.join(__dirname, '../../../uploads/logos');
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    cb(null, 'logo-' + randomUUID() + LOGO_TYPES[file.mimetype]);
  },
});
const uploadLogoMulter = multer({
  storage: logoStorage,
  limits: { fileSize: 2 * 1024 * 1024, ...LOGO_PART_LIMITS }, // 2 MB max
  fileFilter: (req, file, cb) => {
    if (LOGO_TYPES[file.mimetype]) return cb(null, true);
    cb(new ValidationError('Only JPEG, PNG or WEBP images are allowed'));
  },
});

// Same shape as `receive` in user.router.js: multer refusals become 400s.
const receiveLogo = (req, res, next) =>
  uploadLogoMulter.single('logo')(req, res, (error) => {
    if (!error || error instanceof AppError) return next(error);
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') return next(new ValidationError('That file is larger than 2 MB.'));
      return next(new ValidationError(`The upload was refused: ${error.message.toLowerCase()}.`));
    }
    return next(error);
  });

const verifyLogoBytes = (req, res, next) => {
  if (!req.file) return next();
  let valid = false;
  try {
    valid = req.file.size > 0 && hasSignature(req.file.path, req.file.mimetype);
  } catch {
    valid = false;
  }
  if (!valid) {
    fs.unlink(req.file.path, () => {});
    return next(new ValidationError(req.file.size === 0 ? 'The file is empty.' : 'The file is not a valid JPEG, PNG or WEBP image'));
  }
  next();
};

// `authorize` demands ALL listed permissions; the logo is uploaded from both
// the create form and the edit form, so either grant must do.
const canTouchOrganizations = (req, res, next) => {
  if (hasPermission(req.user, 'ORG_CREATE') || hasPermission(req.user, 'ORG_MODIFY')) return next();
  next(new ForbiddenError('Insufficient permissions'));
};

// Organizations
organizationRouter.get('/organizations', authorize('ORG_READ'), validate(listQuerySchema, 'query'), listOrganizations);
organizationRouter.post('/organizations', authorize('ORG_CREATE'), validate(createOrganizationSchema), createOrganization);
organizationRouter.post('/organizations/logo', canTouchOrganizations, uploadLimiter, receiveLogo, verifyLogoBytes, uploadLogo);
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
