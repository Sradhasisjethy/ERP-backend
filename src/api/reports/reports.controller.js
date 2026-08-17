const { asyncHandler } = require('../../core/asyncHandler');
const { ReportsService } = require('./reports.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { hasViewRates } = require('../../utils/fieldMasking');
const { hasPermission } = require('../../middlewares/authorize');
const { ValidationError, NotFoundError, ForbiddenError } = require('../../core/AppError');
const analyticsController = require('../analytics/analytics.controller');
const gstrController = require('../gstr/gstr.controller');
const { toCsv, toPdf } = require('../../utils/exporter');
const { REPORT_COLUMNS, flattenForExport } = require('./reportColumns');
const { CATEGORIES, getReportByPath, allReports } = require('./definitions');
const { executeReport } = require('./lib/runner');
const { visibleColumns, visibleMetrics } = require('./lib/columns');
const { describeFilters } = require('./lib/filters');
const { exportReport: renderExport } = require('./export');

// ===========================================================================
// Reports module (catalog-driven)
// ===========================================================================

/**
 * Resolves `/:category/:report` to a definition and checks the caller may see
 * it. View permission is checked here rather than in a route guard because the
 * required permission depends on which report was asked for.
 */
const resolveReport = (req, { forExport = false } = {}) => {
  const definition = getReportByPath(req.params.category, req.params.report);
  if (!definition) throw new NotFoundError('Report not found');

  if (!hasPermission(req.user, definition.permissions.view)) {
    throw new ForbiddenError('You do not have permission to view this report');
  }
  if (forExport && !hasPermission(req.user, definition.permissions.export)) {
    throw new ForbiddenError('You do not have permission to export this report');
  }
  return definition;
};

/**
 * Strips a definition down to what a client needs to render it, with columns
 * and summary tiles already filtered to what this user may receive. The client
 * never learns that a column it cannot see exists.
 */
const publicDefinition = (definition, req) => ({
  id: definition.id,
  category: definition.category,
  slug: definition.slug,
  path: definition.path,
  name: definition.name,
  description: definition.description,
  kind: definition.kind,
  dateFieldLabel: definition.dateFieldLabel || null,
  partyTypeScope: definition.partyTypeScope || null,
  filters: definition.filters,
  // Full descriptors — label, control type and vocabulary — so the client
  // renders the filter bar from the server's definition rather than from its
  // own guess about what each key means (§6).
  filterControls: describeFilters(definition),
  defaultFilters: definition.defaultFilters,
  defaultSort: definition.defaultSort || null,
  searchFields: definition.searchFields,
  limitations: definition.limitations || [],
  columns: visibleColumns(definition.columns, { user: req.user }),
  summary: visibleMetrics(definition.summary, { user: req.user }),
  canExport: hasPermission(req.user, definition.permissions.export),
});

/**
 * The whole catalog, filtered to what this user may see. Categories with no
 * visible reports are dropped so the UI never renders an empty tab.
 */
const catalog = asyncHandler(async (req, res) => {
  const visible = allReports().filter((definition) => hasPermission(req.user, definition.permissions.view));
  const byCategory = new Map();
  for (const definition of visible) {
    if (!byCategory.has(definition.category)) byCategory.set(definition.category, []);
    byCategory.get(definition.category).push({
      id: definition.id,
      slug: definition.slug,
      path: definition.path,
      name: definition.name,
      description: definition.description,
      kind: definition.kind,
      canExport: hasPermission(req.user, definition.permissions.export),
    });
  }

  const categories = CATEGORIES.filter((category) => byCategory.has(category.id)).map((category) => ({
    id: category.id,
    name: category.name,
    description: category.description,
    reports: byCategory.get(category.id),
  }));

  sendSuccess(res, { categories, canViewRates: hasViewRates(req) }, 'Report catalog retrieved successfully');
});

/** A single report's definition, without running it — used to build the filter bar. */
const meta = asyncHandler(async (req, res) => {
  sendSuccess(res, publicDefinition(resolveReport(req), req), 'Report definition retrieved successfully');
});

/**
 * Runs a report and returns one page plus the summary over the whole filtered
 * set. The response carries the column list it was rendered against, so the
 * client renders exactly what the server allowed rather than a list it decided
 * for itself.
 */
const data = asyncHandler(async (req, res) => {
  const definition = resolveReport(req);
  const params = { ...definition.defaultFilters, ...req.query };
  const result = await executeReport(definition, req, params);

  sendList(
    res,
    { query: { page: result.page, limit: result.limit } },
    {
      rows: result.rows,
      count: result.count,
      summary: result.summary,
      columns: result.columns,
      metrics: result.metrics,
      sort: result.sort,
      report: publicDefinition(definition, req),
    },
    'Report generated successfully'
  );
});

/**
 * Exports the same report at full size. `mode: 'export'` is the only
 * difference from `data` above — same definition, same filters, same
 * permission stripping (§15/§18).
 */
const exportCatalogReport = asyncHandler(async (req, res) => {
  const definition = resolveReport(req, { forExport: true });
  const { format, ...query } = req.query;
  const params = { ...definition.defaultFilters, ...query };
  await renderExport(definition, req, params, format, res);
});

// ===========================================================================
// Saved reports (M40) — unchanged behaviour, kept for existing consumers
// ===========================================================================

/**
 * Running a saved report must never reveal more than calling the underlying
 * endpoint directly would, so each reportType reuses that module's own BR-27
 * mask rather than re-deriving one here.
 */
const MASKERS = {
  STOCK_AGEING: analyticsController.maskStockAgeing,
  DASHBOARD_KPIS: analyticsController.maskDashboardKpis,
  COSTING: analyticsController.maskCostingReport,
  ALERTS: analyticsController.maskAlerts,
  CANCELLATION_ANALYTICS: analyticsController.maskCancellationAnalytics,
  DOCUMENT_SEARCH: (data) => data, // Document numbers and dates only — no money fields.
  TRIAL_BALANCE: (data) => data.map((r) => ({ ...r, totalDebitPaise: null, totalCreditPaise: null, balancePaise: null })),
  PARTY_LEDGER: (data) => ({
    ...data,
    rows: data.rows.map((r) => {
      const plain = typeof r.toJSON === 'function' ? r.toJSON() : r;
      return { ...plain, debitPaise: null, creditPaise: null };
    }),
    outstandingPaise: null,
  }),
  CASH_BOOK: (data) => data.map((r) => ({ ...r, debitPaise: null, creditPaise: null, runningBalancePaise: null })),
  GSTR1: gstrController.maskGstr1,
  GSTR3B: gstrController.maskGstr3b,
};

const maskResult = (reportType, data, req) => (hasViewRates(req) ? data : MASKERS[reportType](data));

const list = asyncHandler(async (req, res) => {
  const { page, limit, search } = req.query;
  sendList(res, req, await ReportsService.list(Number(page), Number(limit), { search }), 'Saved reports retrieved successfully');
});

const get = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReportsService.get(req.params.id), 'Saved report retrieved successfully');
});

const create = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReportsService.create(req.body), 'Saved report created successfully', 201);
});

const remove = asyncHandler(async (req, res) => {
  await ReportsService.delete(req.params.id);
  sendSuccess(res, null, 'Saved report deleted successfully');
});

const run = asyncHandler(async (req, res) => {
  const { reportType, params } = req.body;
  const result = await ReportsService.run(reportType, params);
  sendSuccess(res, maskResult(reportType, result, req), 'Report generated successfully');
});

const runSaved = asyncHandler(async (req, res) => {
  const report = await ReportsService.get(req.params.id);
  const result = await ReportsService.runSaved(req.params.id, req.body.params);
  sendSuccess(res, maskResult(report.reportType, result, req), 'Report generated successfully');
});

/**
 * FR-M27-2/3: exports a saved report to CSV or PDF, carrying the company header
 * and the applied filters. Money columns are dropped entirely — not blanked —
 * for users without VIEW_RATES.
 */
const exportSavedReport = asyncHandler(async (req, res) => {
  const { reportType, params, format = 'csv' } = req.body;
  const raw = await ReportsService.run(reportType, params);
  const masked = maskResult(reportType, raw, req);

  const spec = REPORT_COLUMNS[reportType];
  if (!spec) throw new ValidationError(`"${reportType}" cannot be exported`);

  const rows = flattenForExport(reportType, masked);
  const canViewRates = hasViewRates(req);
  const payload = {
    title: spec.title,
    filters: params || {},
    columns: spec.columns,
    rows,
    canViewRates,
    company: { name: req.user?.tenantName || 'Organization' },
  };

  const stamp = new Date().toISOString().slice(0, 10);
  const filename = `${reportType.toLowerCase()}-${stamp}`;

  if (format === 'pdf') {
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);
    return toPdf(payload, res);
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.csv"`);
  return res.send(toCsv(payload));
});

module.exports = {
  catalog,
  meta,
  data,
  exportCatalogReport,
  exportReport: exportSavedReport,
  list,
  get,
  create,
  remove,
  run,
  runSaved,
};
