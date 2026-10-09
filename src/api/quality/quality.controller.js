const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories, assertCanSeeRecord } = require('../../core/salesScope');
const { QualityService } = require('./quality.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

// BR-27: every response here can carry a product (or a lot/line with one), and
// products have cost and price columns. Masked at the controller like sales is.

const listInspections = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, lotId, inspectionType, result, search, sortBy, sortDir } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await QualityService.listInspections(Number(page), Number(limit), {
    inspectionType, result, productId, lotId, search, sortBy, sortDir, baseWhere,
  });
  sendList(res, req, maskRateFields(data, req), 'Quality inspections retrieved successfully');
});

const getInspection = asyncHandler(async (req, res) => {
  const data = await QualityService.getInspection(req.params.id);
  await assertCanSeeRecord(req, data, 'Quality inspection not found');
  sendSuccess(res, maskRateFields(data, req), 'Quality inspection retrieved successfully');
});

const createInspection = asyncHandler(async (req, res) => {
  const data = await QualityService.createInspection(req.body);
  sendSuccess(res, maskRateFields(data, req), 'Quality inspection recorded successfully', 201);
});

const recordResult = asyncHandler(async (req, res) => {
  // BR-29: passing or failing another location's lot is the same breach as reading it.
  await assertCanSeeRecord(req, await QualityService.getInspection(req.params.id), 'Quality inspection not found');
  const data = await QualityService.recordResult(req.params.id, req.body);
  sendSuccess(res, maskRateFields(data, req), 'Inspection result recorded successfully');
});

const listHeldLots = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await QualityService.listHeldLots(Number(page), Number(limit), { productId, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Lots awaiting quality clearance retrieved successfully');
});

module.exports = { listInspections, getInspection, createInspection, recordResult, listHeldLots };
