const { SavedReport } = require('./savedReport.model');
const { searchWhere } = require('../../utils/pagination');
const { AnalyticsService } = require('../analytics/analytics.service');
const { LedgerService } = require('../ledger/ledger.service');
const { GstrService } = require('../gstr/gstr.service');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../core/AppError');
const { hasPermission } = require('../../middlewares/authorize');
const { getAllowedFactoryIds } = require('../../core/factoryAccess');
const { assertCanUseFactory } = require('../../core/salesScope');

/**
 * M40 "report builder": each reportType maps to one already-built, already-
 * tested read-only method elsewhere in the system — this is a thin naming/
 * scheduling layer over them, not a general query engine. `run()` returns
 * the raw (unmasked) result; callers apply BR-27 masking themselves (see
 * reports.controller.js), the same way each source module's own controller does.
 */
/**
 * The module permission each legacy report actually reads.
 *
 * The routes for these carry `REPORT_READ` alone, which made that one grant a
 * skeleton key: it returned the trial balance without LEDGER_READ, the GST
 * position without GSTR_READ and the costing report without ANALYTICS_READ.
 * `REPORT_READ` says you may use the saved-report feature; it does not say
 * which data you may point it at. Both are now required.
 *
 * The catalog reports next door already work this way — each definition names
 * its own view and export permissions and `resolveReport` checks them.
 */
const REPORT_PERMISSIONS = {
  STOCK_AGEING: 'INVENTORY_READ',
  DASHBOARD_KPIS: 'ANALYTICS_READ',
  COSTING: 'ANALYTICS_READ',
  ALERTS: 'ANALYTICS_READ',
  CANCELLATION_ANALYTICS: 'ANALYTICS_READ',
  DOCUMENT_SEARCH: 'REPORT_READ',
  TRIAL_BALANCE: 'LEDGER_READ',
  PARTY_LEDGER: 'LEDGER_READ',
  CASH_BOOK: 'LEDGER_READ',
  GSTR1: 'GSTR_READ',
  GSTR3B: 'GSTR_READ',
};

/** Reports whose result is a single factory's figures. */
const FACTORY_SCOPED_REPORTS = new Set([
  'STOCK_AGEING', 'DASHBOARD_KPIS', 'COSTING', 'ALERTS',
  'CANCELLATION_ANALYTICS', 'TRIAL_BALANCE', 'CASH_BOOK', 'GSTR1', 'GSTR3B',
]);

const RUNNERS = {
  STOCK_AGEING: (p) => AnalyticsService.getStockAgeing(p.factoryId, { deadStockDays: p.deadStockDays }),
  DASHBOARD_KPIS: (p) => AnalyticsService.getDashboardKpis(p.factoryId, { fromDate: p.fromDate, toDate: p.toDate }),
  COSTING: (p) => AnalyticsService.getCostingReport(p.factoryId),
  ALERTS: (p) => AnalyticsService.getAlerts(p.factoryId),
  CANCELLATION_ANALYTICS: (p) => AnalyticsService.getCancellationAnalytics(p.factoryId, { fromDate: p.fromDate, toDate: p.toDate }),
  DOCUMENT_SEARCH: (p) => AnalyticsService.searchDocuments(p.q, { limit: p.limit }),
  TRIAL_BALANCE: (p) => LedgerService.getTrialBalance(p.factoryId),
  PARTY_LEDGER: async (p) => {
    const [ledger, outstandingPaise] = await Promise.all([
      LedgerService.getPartyLedger(p.partyId, { page: p.page || 1, limit: p.limit || 50 }),
      LedgerService.getPartyOutstanding(p.partyId),
    ]);
    return { rows: ledger.rows, count: ledger.count, outstandingPaise };
  },
  CASH_BOOK: (p) => LedgerService.getCashBook(p.factoryId, { from: p.from, to: p.to, accountKey: p.accountKey }),
  GSTR1: (p) => GstrService.getGstr1(p.factoryId, { fromDate: p.fromDate, toDate: p.toDate }),
  GSTR3B: (p) => GstrService.getGstr3b(p.factoryId, { fromDate: p.fromDate, toDate: p.toDate }),
};

class ReportsService {
  static async list(page, limit, { search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) Object.assign(where, searchWhere(search, ['name']));
    return SavedReport.findAndCountAll({ where, limit, offset, order: [['createdAt', 'DESC']] });
  }

  static async get(id) {
    const report = await SavedReport.findByPk(id);
    if (!report) throw new NotFoundError('Saved report not found');
    return report;
  }

  static async create({ name, reportType, params }) {
    if (!RUNNERS[reportType]) throw new ValidationError(`Unknown report type: ${reportType}`);
    return SavedReport.create({ name, reportType, params: params || {} });
  }

  static async delete(id) {
    const report = await this.get(id);
    await report.destroy();
  }

  /**
   * Proves the caller may read this report's data, for this location.
   *
   * `req` was never passed down here, so `getAllowedFactoryIds` was never
   * consulted and `params.factoryId` was honoured for any plant the caller
   * cared to name — BR-29 bypassed entirely, and `enforceFactoryScope` is not
   * mounted on this router either.
   *
   * When a restricted user names no factory the request is refused rather than
   * quietly widened to every plant. Running "all locations" is a real answer
   * for an unrestricted user and a leak for anyone else, so it has to be asked
   * for explicitly by someone entitled to it.
   */
  static async assertMayRun(req, reportType, params = {}) {
    const required = REPORT_PERMISSIONS[reportType];
    if (required && !hasPermission(req.user, required)) {
      throw new ForbiddenError(`You do not have permission to run this report (${reportType})`);
    }

    if (!FACTORY_SCOPED_REPORTS.has(reportType)) return;

    if (params.factoryId) {
      await assertCanUseFactory(req, params.factoryId);
      return;
    }

    const allowed = await getAllowedFactoryIds(req);
    if (allowed !== null) {
      throw new ForbiddenError('Name the location this report is for — you are not permitted to run it across every location');
    }
  }

  static async run(reportType, params, req) {
    const runner = RUNNERS[reportType];
    if (!runner) throw new ValidationError(`Unknown report type: ${reportType}`);
    if (req) await this.assertMayRun(req, reportType, params || {});
    return runner(params || {});
  }

  static async runSaved(id, paramOverrides, req) {
    const report = await this.get(id);
    // Checked against the merged params, not the stored ones: a saved report is
    // a convenience, never a way to carry someone else's factory id forward.
    return this.run(report.reportType, { ...report.params, ...(paramOverrides || {}) }, req);
  }
}

module.exports = { ReportsService, RUNNERS };
