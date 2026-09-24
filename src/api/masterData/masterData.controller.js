const { asyncHandler } = require('../../core/asyncHandler');
const { sendSuccess, sendList } = require('../../utils/response');
const { hasViewRates } = require('../../utils/fieldMasking');
const { hasPermission } = require('../../middlewares/authorize');
const { MasterDataService } = require('./masterData.service');
const { getConfig } = require('./registry');
const { ValidationError } = require('../../core/AppError');

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * A workbook comes back as a download, not as JSON. `Content-Disposition` is
 * also exposed to the browser explicitly — without that header in
 * `Access-Control-Expose-Headers` an app served from a different origin cannot
 * read the filename and every download lands as "download.xlsx".
 */
const sendWorkbook = (res, { buffer, fileName }) => {
  res.setHeader('Content-Type', XLSX_TYPE);
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  res.setHeader('Content-Length', Buffer.byteLength(buffer));
  return res.status(200).send(Buffer.from(buffer));
};

const modules = asyncHandler(async (req, res) => {
  sendSuccess(res, MasterDataService.modules(), 'Master data modules retrieved successfully');
});

const template = asyncHandler(async (req, res) => {
  const file = await MasterDataService.template(req.params.module, { canViewRates: hasViewRates(req) });
  sendWorkbook(res, file);
});

const exportRecords = asyncHandler(async (req, res) => {
  const file = await MasterDataService.exportRecords(req.params.module, {
    query: req.query,
    canViewRates: hasViewRates(req),
  });
  sendWorkbook(res, file);
});

const validateImport = asyncHandler(async (req, res) => {
  if (!req.file) throw new ValidationError('Choose an Excel file to upload.');
  const { importMode, ...query } = req.query || {};

  const result = await MasterDataService.validate(req.params.module, {
    buffer: req.file.buffer,
    fileName: req.file.originalname,
    importMode: importMode || 'UPSERT',
    query,
    canViewRates: hasViewRates(req),
    userId: req.user?.userId,
    can: (permission) => hasPermission(req.user, permission),
  });

  // 200 either way: a file full of bad rows is a successful check that found
  // problems, and the client needs the same payload to show them.
  sendSuccess(res, result, result.errorRows ? `${result.errorRows} row(s) need fixing before this file can be imported` : 'File checked — review the preview and confirm');
});

const commitImport = asyncHandler(async (req, res) => {
  const result = await MasterDataService.commit(req.params.importId, {
    canViewRates: hasViewRates(req),
    userId: req.user?.userId,
    can: (permission) => hasPermission(req.user, permission),
  });
  sendSuccess(res, result, `Imported: ${result.createdCount} created, ${result.updatedCount} updated`);
});

const getImport = asyncHandler(async (req, res) => {
  const run = await MasterDataService.getRun(req.params.importId);
  const preview = MasterDataService.preview(run, { config: getConfig(run.module), canViewRates: hasViewRates(req) });
  sendSuccess(res, preview, 'Import retrieved successfully');
});

const importErrors = asyncHandler(async (req, res) => {
  const file = await MasterDataService.errorWorkbook(req.params.importId, { canViewRates: hasViewRates(req) });
  sendWorkbook(res, file);
});

const listRuns = asyncHandler(async (req, res) => {
  sendList(res, req, await MasterDataService.listRuns(req.query), 'Imports retrieved successfully');
});

module.exports = { modules, template, exportRecords, validateImport, commitImport, getImport, importErrors, listRuns };
