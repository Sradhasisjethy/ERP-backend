const { asyncHandler } = require('../../core/asyncHandler');
const { FactoryService } = require('./factory.service');
const { sendSuccess, sendList } = require('../../utils/response');

// Factories
const listFactories = asyncHandler(async (req, res) => {
  const { page, limit, organizationId, search, status } = req.query;
  const data = await FactoryService.listFactories(Number(page), Number(limit), organizationId, search, status);
  sendList(res, req, data, 'Factories retrieved successfully');
});

const getFactory = asyncHandler(async (req, res) => {
  const data = await FactoryService.getFactory(req.params.id);
  sendSuccess(res, data, 'Factory retrieved successfully');
});

const createFactory = asyncHandler(async (req, res) => {
  const data = await FactoryService.createFactory(req.body);
  sendSuccess(res, data, 'Factory created successfully', 201);
});

const updateFactory = asyncHandler(async (req, res) => {
  const data = await FactoryService.updateFactory(req.params.id, req.body);
  sendSuccess(res, data, 'Factory updated successfully');
});

const deleteFactory = asyncHandler(async (req, res) => {
  await FactoryService.deleteFactory(req.params.id);
  sendSuccess(res, null, 'Factory deleted successfully');
});

// Financial Years
const listFinancialYears = asyncHandler(async (req, res) => {
  const { page, limit, search } = req.query;
  const data = await FactoryService.listFinancialYears(Number(page), Number(limit), { search });
  sendList(res, req, data, 'Financial years retrieved successfully');
});

const getCurrentFinancialYear = asyncHandler(async (req, res) => {
  const data = await FactoryService.getCurrentFinancialYear();
  sendSuccess(res, data, 'Current financial year retrieved successfully');
});

const createFinancialYear = asyncHandler(async (req, res) => {
  const data = await FactoryService.createFinancialYear(req.body);
  sendSuccess(res, data, 'Financial year created successfully', 201);
});

const setCurrentFinancialYear = asyncHandler(async (req, res) => {
  const data = await FactoryService.setCurrentFinancialYear(req.params.id);
  sendSuccess(res, data, 'Current financial year updated successfully');
});

// User <-> Factory assignment
const listAssignedUsers = asyncHandler(async (req, res) => {
  const data = await FactoryService.listAssignedUsers(req.params.id);
  sendSuccess(res, data, 'Assigned users retrieved successfully');
});

const assignUser = asyncHandler(async (req, res) => {
  const data = await FactoryService.assignUser(req.params.id, req.body.userId);
  sendSuccess(res, data, 'User assigned to factory successfully', 201);
});

const unassignUser = asyncHandler(async (req, res) => {
  await FactoryService.unassignUser(req.params.id, req.params.userId);
  sendSuccess(res, null, 'User unassigned from factory successfully');
});

module.exports = {
  listFactories,
  getFactory,
  createFactory,
  updateFactory,
  deleteFactory,
  listFinancialYears,
  getCurrentFinancialYear,
  createFinancialYear,
  setCurrentFinancialYear,
  listAssignedUsers,
  assignUser,
  unassignUser,
};
