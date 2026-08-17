const { asyncHandler } = require('../../core/asyncHandler');
const { AnalyticsService } = require('./analytics.service');
const { sendSuccess } = require('../../utils/response');
const { hasViewRates } = require('../../utils/fieldMasking');

// These payloads nest money fields several levels deep (buckets, lots[],
// topProducts[], byDocumentType[], alert rows) — deeper than the generic
// maskRateFields helper reaches (it only strips top-level / `.rows` fields,
// per ledger.controller.js's getPartyLedger precedent), so BR-27 masking is
// done explicitly here instead of delegating to that helper. Exported so
// reports.service.js (M40) can apply the same masking when a saved report
// re-runs one of these underlying analytics calls.

const maskStockAgeing = (data) => ({
  ...data,
  lots: data.lots.map((l) => ({ ...l, valuePaise: null })),
  deadStock: data.deadStock.map((l) => ({ ...l, valuePaise: null })),
  buckets: Object.fromEntries(Object.entries(data.buckets).map(([k, v]) => [k, { ...v, valuePaise: null }])),
});

const maskDashboardKpis = (data) => ({
  ...data,
  salesValuePaise: null, purchaseValuePaise: null, cashBalancePaise: null, bankBalancePaise: null,
  outstandingReceivablesPaise: null, outstandingPayablesPaise: null,
  topProducts: data.topProducts.map((p) => ({ ...p, totalPaise: null })),
  topCustomers: data.topCustomers.map((c) => ({ ...c, totalPaise: null })),
});

const maskCostingReport = (data) =>
  data.map((r) => ({ ...r, standardCostPaise: null, avgSellingRatePaise: null, marginPaise: null, marginPercent: null, avgContractorPieceRatePaise: null }));

const maskAlerts = (data) => data.map((a) => ({ ...a, outstandingPaise: undefined, balancePaise: undefined }));

const maskCancellationAnalytics = (data) => ({ ...data, byDocumentType: data.byDocumentType.map((d) => ({ ...d, totalValuePaise: null })) });

const getStockAgeing = asyncHandler(async (req, res) => {
  const { factoryId, deadStockDays } = req.query;
  const data = await AnalyticsService.getStockAgeing(factoryId, { deadStockDays });
  sendSuccess(res, hasViewRates(req) ? data : maskStockAgeing(data), 'Stock ageing retrieved successfully');
});

const getDashboardKpis = asyncHandler(async (req, res) => {
  const { factoryId, fromDate, toDate } = req.query;
  const data = await AnalyticsService.getDashboardKpis(factoryId, { fromDate, toDate });
  sendSuccess(res, hasViewRates(req) ? data : maskDashboardKpis(data), 'Dashboard KPIs retrieved successfully');
});

const getCostingReport = asyncHandler(async (req, res) => {
  const data = await AnalyticsService.getCostingReport(req.query.factoryId);
  sendSuccess(res, hasViewRates(req) ? data : maskCostingReport(data), 'Costing report retrieved successfully');
});

const getAlerts = asyncHandler(async (req, res) => {
  const data = await AnalyticsService.getAlerts(req.query.factoryId);
  sendSuccess(res, hasViewRates(req) ? data : maskAlerts(data), 'Alerts retrieved successfully');
});

const getCancellationAnalytics = asyncHandler(async (req, res) => {
  const { factoryId, fromDate, toDate } = req.query;
  const data = await AnalyticsService.getCancellationAnalytics(factoryId, { fromDate, toDate });
  sendSuccess(res, hasViewRates(req) ? data : maskCancellationAnalytics(data), 'Cancellation analytics retrieved successfully');
});

const searchDocuments = asyncHandler(async (req, res) => {
  const { q, limit } = req.query;
  const data = await AnalyticsService.searchDocuments(q, { limit });
  sendSuccess(res, data, 'Search results retrieved successfully');
});

module.exports = {
  getStockAgeing, getDashboardKpis, getCostingReport, getAlerts, getCancellationAnalytics, searchDocuments,
  maskStockAgeing, maskDashboardKpis, maskCostingReport, maskAlerts, maskCancellationAnalytics,
};
