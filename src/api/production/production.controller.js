const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories } = require('../../core/salesScope');
const { ProductionService } = require('./production.service');
const { sendSuccess, sendList } = require('../../utils/response');

// Production Plan
const generateProposal = asyncHandler(async (req, res) => {
  const data = await ProductionService.generateProposal(req.body.factoryId, req.body.planDate);
  sendSuccess(res, data, 'Production plan proposed successfully', 201);
});
const listPlans = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, status, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ProductionService.listPlans(Number(page), Number(limit), { status, search, baseWhere });
  sendList(res, req, data, 'Production plans retrieved successfully');
});
const getPlan = asyncHandler(async (req, res) => {
  const data = await ProductionService.getPlan(req.params.id);
  sendSuccess(res, data, 'Production plan retrieved successfully');
});
const confirmPlan = asyncHandler(async (req, res) => {
  const data = await ProductionService.confirmPlan(req.params.id, req.body.lines);
  sendSuccess(res, data, 'Production plan confirmed successfully');
});

// Production Entry
const listEntries = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, status, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ProductionService.listEntries(Number(page), Number(limit), { productId, status, search, baseWhere });
  sendList(res, req, data, 'Production entries retrieved successfully');
});
const getEntry = asyncHandler(async (req, res) => {
  const data = await ProductionService.getEntry(req.params.id);
  sendSuccess(res, data, 'Production entry retrieved successfully');
});
const createEntry = asyncHandler(async (req, res) => {
  const data = await ProductionService.createEntry(req.body);
  sendSuccess(res, data, 'Production entry posted successfully', 201);
});

// Variance approval
const listPendingApprovals = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ProductionService.listPendingApprovals(Number(page), Number(limit), { search, baseWhere });
  sendList(res, req, data, 'Pending variance approvals retrieved successfully');
});
const approveVariance = asyncHandler(async (req, res) => {
  const data = await ProductionService.approveVariance(req.params.id);
  sendSuccess(res, data, 'Variance approved successfully');
});

// Wastage
const listWastage = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, stage, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ProductionService.listWastage(Number(page), Number(limit), { productId, stage, search, baseWhere });
  sendList(res, req, data, 'Wastage records retrieved successfully');
});
const createWastage = asyncHandler(async (req, res) => {
  const data = await ProductionService.createWastage(req.body);
  sendSuccess(res, data, 'Wastage recorded successfully', 201);
});

module.exports = {
  generateProposal, listPlans, getPlan, confirmPlan,
  listEntries, getEntry, createEntry,
  listPendingApprovals, approveVariance,
  listWastage, createWastage,
};
