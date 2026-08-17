const { asyncHandler } = require('../../core/asyncHandler');
const { WorkforceService } = require('./workforce.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

// Contractor material issue
const listMaterialIssues = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, contractorPartyId, search } = req.query;
  sendList(res, req, await WorkforceService.listMaterialIssues(Number(page), Number(limit), { factoryId, contractorPartyId, search }), 'Material issues retrieved successfully');
});
const getMaterialIssue = asyncHandler(async (req, res) => {
  sendSuccess(res, await WorkforceService.getMaterialIssue(req.params.id), 'Material issue retrieved successfully');
});
const issueMaterial = asyncHandler(async (req, res) => {
  sendSuccess(res, await WorkforceService.issueMaterialToContractor(req.body), 'Material issued to contractor successfully', 201);
});

// Contractor production entry
const listContractorEntries = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, contractorPartyId, search } = req.query;
  const data = await WorkforceService.listContractorEntries(Number(page), Number(limit), { factoryId, contractorPartyId, search });
  sendList(res, req, maskRateFields(data, req, ['pieceRatePaise', 'totalValuePaise']), 'Contractor production entries retrieved successfully');
});
const getContractorEntry = asyncHandler(async (req, res) => {
  sendSuccess(res, maskRateFields(await WorkforceService.getContractorEntry(req.params.id), req, ['pieceRatePaise', 'totalValuePaise']), 'Contractor production entry retrieved successfully');
});
const createContractorEntry = asyncHandler(async (req, res) => {
  sendSuccess(res, await WorkforceService.createContractorProductionEntry(req.body), 'Contractor production entry posted successfully', 201);
});

// Attendance
const listAttendance = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, labourPartyId, search } = req.query;
  const data = await WorkforceService.listAttendance(Number(page), Number(limit), { factoryId, labourPartyId, search });
  sendList(res, req, maskRateFields(data, req, ['wageAccruedPaise']), 'Attendance retrieved successfully');
});
const markAttendance = asyncHandler(async (req, res) => {
  sendSuccess(res, await WorkforceService.markAttendance(req.body), 'Attendance marked successfully', 201);
});

// Advances
const listAdvances = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, partyId, search } = req.query;
  const data = await WorkforceService.listAdvances(Number(page), Number(limit), { factoryId, partyId, search });
  sendList(res, req, maskRateFields(data, req, ['amountPaise']), 'Advances retrieved successfully');
});
const createAdvance = asyncHandler(async (req, res) => {
  sendSuccess(res, await WorkforceService.createAdvance(req.body), 'Advance posted successfully', 201);
});
const cancelAdvance = asyncHandler(async (req, res) => {
  sendSuccess(res, await WorkforceService.cancelAdvance(req.params.id, req.body.reason), 'Advance cancelled successfully');
});

module.exports = {
  listMaterialIssues, getMaterialIssue, issueMaterial,
  listContractorEntries, getContractorEntry, createContractorEntry,
  listAttendance, markAttendance,
  listAdvances, createAdvance, cancelAdvance,
};
