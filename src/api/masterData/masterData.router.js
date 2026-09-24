const { Router } = require('express');
const multer = require('multer');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { hasPermission } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { ForbiddenError, ValidationError } = require('../../core/AppError');
const { getTenantContext } = require('../../core/tenantContext');
const { getConfig, permissionsFor } = require('./registry');
const { MasterDataService } = require('./masterData.service');
const controller = require('./masterData.controller');
const schema = require('./masterData.schema');

const masterDataRouter = Router();

masterDataRouter.use(authenticate, tenantScope, auditContext);

const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const XLSX_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/octet-stream',
]);

/**
 * The upload is held in memory, never on disk.
 *
 * A master-data file is a few hundred kilobytes and is parsed immediately, so
 * writing it to the filesystem would buy nothing and cost a temp file to clean
 * up, a path to traverse and a directory to keep private. 5 MB is well above
 * any legitimate 5,000-row master file and well below anything that threatens
 * the process.
 *
 * The extension and the declared type are both checked, and neither is
 * trusted — ExcelJS refuses to open anything that is not really a workbook,
 * which is the check that actually holds.
 */
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10 },
  fileFilter: (req, file, cb) => {
    const named = /\.xlsx$/i.test(file.originalname || '');
    if (!named) return cb(new ValidationError('Only .xlsx files can be imported. Save the file as Excel Workbook (.xlsx) and try again.'));
    if (file.mimetype && !XLSX_TYPES.has(file.mimetype)) {
      return cb(new ValidationError('That does not look like an Excel workbook.'));
    }
    return cb(null, true);
  },
});

/**
 * Reads the upload, and keeps the tenant context while doing it.
 *
 * cls-hooked carries context across promises and timers, but not across a
 * stream whose socket was created before `tenantScope` opened the context.
 * multer parses the file from `req`'s data events, so without binding the
 * emitter the tenant id is gone by the time the file is in hand — and the
 * first insert fails with "tenantId cannot be null" on a request that was
 * authenticated and scoped perfectly well.
 */
const receiveFile = (req, res, next) => {
  const session = getTenantContext();
  if (session && session.active) {
    session.bindEmitter(req);
    session.bindEmitter(res);
  }

  return upload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error.code === 'LIMIT_FILE_SIZE') {
      return next(new ValidationError('That file is larger than 5 MB. Split it and import in parts.'));
    }
    return next(error instanceof ValidationError ? error : new ValidationError(error.message));
  });
};

/**
 * The permission depends on which master is being touched, so it is resolved
 * per request rather than baked into the route. Import and export are separate
 * grants because they are different acts: one changes the master file everybody
 * works from, the other takes a copy of it out of the building.
 */
const authorizeModule = (action) => (req, res, next) => {
  try {
    const config = getConfig(req.params.module);
    const permission = permissionsFor(config)[action];
    if (!hasPermission(req.user, permission)) {
      return next(new ForbiddenError(`You do not have permission to ${action} ${config.label}`));
    }
    req.masterConfig = config;
    return next();
  } catch (error) {
    return next(error);
  }
};

/** Same check, for the routes that name a run rather than a module. */
const authorizeRun = (action) => async (req, res, next) => {
  try {
    const run = await MasterDataService.getRun(req.params.importId);
    const config = getConfig(run.module);
    if (!hasPermission(req.user, permissionsFor(config)[action])) {
      return next(new ForbiddenError(`You do not have permission to ${action} ${config.label}`));
    }
    return next();
  } catch (error) {
    return next(error);
  }
};

masterDataRouter.get('/modules', controller.modules);

// Declared before '/:module' so "imports" is never read as a module key.
masterDataRouter.get('/imports', validate(schema.runsQuerySchema, 'query'), controller.listRuns);
masterDataRouter.get('/imports/:importId', authorizeRun('import'), controller.getImport);
masterDataRouter.post('/imports/:importId/commit', authorizeRun('import'), controller.commitImport);
masterDataRouter.get('/imports/:importId/errors', authorizeRun('import'), controller.importErrors);

// A blank sample is a list of column names, which anyone who may open the
// screen can already read — so it is gated on read, not on import.
masterDataRouter.get('/:module/template', authorizeModule('read'), controller.template);
masterDataRouter.get('/:module/export', authorizeModule('export'), controller.exportRecords);
masterDataRouter.post('/:module/import/validate', authorizeModule('import'), receiveFile, controller.validateImport);

module.exports = { masterDataRouter };
