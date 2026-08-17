const { SavedReport } = require('./savedReport.model');
const { searchWhere } = require('../../utils/pagination');
const { AnalyticsService } = require('../analytics/analytics.service');
const { LedgerService } = require('../ledger/ledger.service');
const { GstrService } = require('../gstr/gstr.service');
const { NotFoundError, ValidationError } = require('../../core/AppError');

/**
 * M40 "report builder": each reportType maps to one already-built, already-
 * tested read-only method elsewhere in the system — this is a thin naming/
 * scheduling layer over them, not a general query engine. `run()` returns
 * the raw (unmasked) result; callers apply BR-27 masking themselves (see
 * reports.controller.js), the same way each source module's own controller does.
 */
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

  static async run(reportType, params) {
    const runner = RUNNERS[reportType];
    if (!runner) throw new ValidationError(`Unknown report type: ${reportType}`);
    return runner(params || {});
  }

  static async runSaved(id, paramOverrides) {
    const report = await this.get(id);
    return this.run(report.reportType, { ...report.params, ...(paramOverrides || {}) });
  }
}

module.exports = { ReportsService, RUNNERS };
