const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories } = require('../../core/salesScope');
const { QualityService } = require('./quality.service');
const { sendSuccess, sendList } = require('../../utils/response');

const listInspections = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId, lotId, inspectionType, result, search, sortBy, sortDir } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await QualityService.listInspections(Number(page), Number(limit), {
    inspectionType, result, productId, lotId, search, sortBy, sortDir, baseWhere,
  });
  sendList(res, req, data, 'Quality inspections retrieved successfully');
});

const getInspection = asyncHandler(async (req, res) => {
  const data = await QualityService.getInspection(req.params.id);
  sendSuccess(res, data, 'Quality inspection retrieved successfully');
});

const createInspection = asyncHandler(async (req, res) => {
  const data = await QualityService.createInspection(req.body);
  sendSuccess(res, data, 'Quality inspection recorded successfully', 201);
});

const recordResult = asyncHandler(async (req, res) => {
  const data = await QualityService.recordResult(req.params.id, req.body);
  sendSuccess(res, data, 'Inspection result recorded successfully');
});

const listHeldLots = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, productId } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await QualityService.listHeldLots(Number(page), Number(limit), { productId, baseWhere });
  sendList(res, req, data, 'Lots awaiting quality clearance retrieved successfully');
});

module.exports = { listInspections, getInspection, createInspection, recordResult, listHeldLots };
