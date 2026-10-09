const { asyncHandler } = require('../../core/asyncHandler');
const { assertMayOverrideLot } = require('../../core/lotOverride');
const { scopeListToFactories, assertCanSeeRecord } = require('../../core/salesScope');
const { ProductionService } = require('./production.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

// BR-27: every response here can carry a product (or a lot/line with one), and
// products have cost and price columns. Masked at the controller like sales is.
const { renderProductionSheetPdf } = require('./productionSheetPdf.service');
const { SettingsService } = require('../settings/settings.service');

// Production Plan
const generateProposal = asyncHandler(async (req, res) => {
  const data = await ProductionService.generateProposal(req.body.factoryId, req.body.planDate);
  sendSuccess(res, maskRateFields(data, req), 'Production plan proposed successfully', 201);
});
const listPlans = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, status, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ProductionService.listPlans(Number(page), Number(limit), { status, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Production plans retrieved successfully');
});
const getPlan = asyncHandler(async (req, res) => {
  const data = await ProductionService.getPlan(req.params.id);
  await assertCanSeeRecord(req, data, 'Production plan not found');
  sendSuccess(res, maskRateFields(data, req), 'Production plan retrieved successfully');
});
const confirmPlan = asyncHandler(async (req, res) => {
  // BR-29: confirming another location's plan is the same breach as reading it.
  await assertCanSeeRecord(req, await ProductionService.getPlan(req.params.id), 'Production plan not found');
  const data = await ProductionService.confirmPlan(req.params.id, req.body.lines);
  sendSuccess(res, maskRateFields(data, req), 'Production plan confirmed successfully');
});

// Production Entry
const listEntries = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, status, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ProductionService.listEntries(Number(page), Number(limit), { productId, status, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Production entries retrieved successfully');
});
const getEntry = asyncHandler(async (req, res) => {
  const data = await ProductionService.getEntry(req.params.id);
  await assertCanSeeRecord(req, data, 'Production entry not found');
  sendSuccess(res, maskRateFields(data, req), 'Production entry retrieved successfully');
});
const createEntry = asyncHandler(async (req, res) => {
  assertMayOverrideLot(req, req.body.materialLines);
  const data = await ProductionService.createEntry(req.body);
  sendSuccess(res, maskRateFields(data, req), 'Production entry posted successfully', 201);
});

// Variance approval
const cancelEntry = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await ProductionService.getEntry(req.params.id), 'Production entry not found');
  const data = await ProductionService.cancelEntry(req.params.id, req.body.reason);
  sendSuccess(res, maskRateFields(data, req), 'Production entry cancelled successfully');
});
const printSheet = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await ProductionService.getPlan(req.params.id), 'Production plan not found');
  const { plan, lines } = await ProductionService.getSheetData(req.params.id);
  const display = await SettingsService.getDisplayPreferences();
  const doc = renderProductionSheetPdf(plan, lines, { display });

  res.setHeader('Content-Type', 'application/pdf');
  // Via the helper: a legacy plant code can put a quote or non-Latin-1 text in the number.
  const { contentDisposition } = require('../../utils/contentDisposition');
  res.setHeader('Content-Disposition', contentDisposition(`${String(plan.planNumber || plan.id).replace(/\//g, '-')}-sheet.pdf`, 'inline'));
  doc.pipe(res);
  doc.end();
});
const listOrders = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, status, productId, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ProductionService.listOrders(Number(page), Number(limit), { status, productId, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Production orders retrieved successfully');
});
const listConsumptions = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, rawMaterialProductId, search } = req.query;
  // Scoped through the joined entry, so the factory filter is resolved here
  // rather than as a plain where-clause on the consumption row.
  const scope = await scopeListToFactories(req, {}, factoryId);
  const data = await ProductionService.listConsumptions(Number(page), Number(limit), {
    productId, rawMaterialProductId, search, factoryId: scope.factoryId,
  });
  sendList(res, req, maskRateFields(data, req), 'Material consumption retrieved successfully');
});
const listPendingApprovals = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, search } = req.query;
  // The service never read a `baseWhere`, so this scope was built and dropped
  // and every plant's pending approvals came back. Passed the way
  // listConsumptions passes it: as the entry's factory filter.
  const scope = await scopeListToFactories(req, {}, factoryId);
  const data = await ProductionService.listPendingApprovals(Number(page), Number(limit), { search, factoryId: scope.factoryId });
  sendList(res, req, maskRateFields(data, req), 'Pending variance approvals retrieved successfully');
});
const approveVariance = asyncHandler(async (req, res) => {
  // A consumption row has no factoryId of its own — its plant is its entry's.
  const consumption = await ProductionService.getConsumption(req.params.id);
  await assertCanSeeRecord(req, { factoryId: consumption.productionEntry?.factoryId }, 'Material consumption record not found');
  const data = await ProductionService.approveVariance(req.params.id);
  sendSuccess(res, maskRateFields(data, req), 'Variance approved successfully');
});

// Wastage
const listWastage = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, stage, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ProductionService.listWastage(Number(page), Number(limit), { productId, stage, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Wastage records retrieved successfully');
});
const createWastage = asyncHandler(async (req, res) => {
  const data = await ProductionService.createWastage(req.body);
  sendSuccess(res, maskRateFields(data, req), 'Wastage recorded successfully', 201);
});

module.exports = {
  generateProposal, listPlans, getPlan, confirmPlan,
  listEntries, getEntry, createEntry, cancelEntry,
  listOrders, listConsumptions, printSheet,
  listPendingApprovals, approveVariance,
  listWastage, createWastage,
};
