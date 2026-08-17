const { asyncHandler } = require('../../core/asyncHandler');
const { MigrationService } = require('./migration.service');
const { sendSuccess } = require('../../utils/response');

const templates = asyncHandler(async (req, res) => {
  sendSuccess(res, MigrationService.templates(), 'Import templates retrieved successfully');
});

const validateImport = asyncHandler(async (req, res) => {
  const { kind, rows } = req.body;
  sendSuccess(res, await MigrationService.validate(kind, rows), 'Import validated');
});

const runImport = asyncHandler(async (req, res) => {
  const { kind, rows, dryRun } = req.body;
  const result = await MigrationService.import(kind, rows, { dryRun });
  // A failed validation is the caller's problem to fix, not a server error —
  // 422 with the per-row detail, so the UI can show exactly which rows to fix.
  if (!result.committed && !result.dryRun) {
    return res.status(422).json({ success: false, message: 'Import rejected — fix the listed rows and retry', data: result });
  }
  sendSuccess(res, result, result.dryRun ? 'Dry run completed — nothing was written' : 'Import completed successfully');
});

const reconcile = asyncHandler(async (req, res) => {
  const { kind, controlTotals } = req.body;
  sendSuccess(res, await MigrationService.reconcile(kind, controlTotals), 'Reconciliation completed');
});

module.exports = { templates, validateImport, runImport, reconcile };
