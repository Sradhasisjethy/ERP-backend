const { asyncHandler } = require('../../core/asyncHandler');
const { OrganizationService } = require('./organization.service');
const { sendSuccess, sendList } = require('../../utils/response');

// Organizations
const listOrganizations = asyncHandler(async (req, res) => {
  const { page, limit, search, status } = req.query;
  const data = await OrganizationService.listOrganizations(Number(page), Number(limit), search, status);
  sendList(res, req, data, 'Organizations retrieved successfully');
});

const getOrganization = asyncHandler(async (req, res) => {
  const data = await OrganizationService.getOrganization(req.params.id);
  sendSuccess(res, data, 'Organization retrieved successfully');
});

const createOrganization = asyncHandler(async (req, res) => {
  const data = await OrganizationService.createOrganization(req.body);
  sendSuccess(res, data, 'Organization created successfully', 201);
});

const updateOrganization = asyncHandler(async (req, res) => {
  const data = await OrganizationService.updateOrganization(req.params.id, req.body);
  sendSuccess(res, data, 'Organization updated successfully');
});

const deleteOrganization = asyncHandler(async (req, res) => {
  await OrganizationService.deleteOrganization(req.params.id);
  sendSuccess(res, null, 'Organization deleted successfully');
});

// Offices
const listOffices = asyncHandler(async (req, res) => {
  const { page, limit, organizationId, search, status } = req.query;
  const data = await OrganizationService.listOffices(Number(page), Number(limit), organizationId, search, status);
  sendList(res, req, data, 'Offices retrieved successfully');
});

const getOffice = asyncHandler(async (req, res) => {
  const data = await OrganizationService.getOffice(req.params.id);
  sendSuccess(res, data, 'Office retrieved successfully');
});

const createOffice = asyncHandler(async (req, res) => {
  const data = await OrganizationService.createOffice(req.body);
  sendSuccess(res, data, 'Office created successfully', 201);
});

const updateOffice = asyncHandler(async (req, res) => {
  const data = await OrganizationService.updateOffice(req.params.id, req.body);
  sendSuccess(res, data, 'Office updated successfully');
});

const deleteOffice = asyncHandler(async (req, res) => {
  await OrganizationService.deleteOffice(req.params.id);
  sendSuccess(res, null, 'Office deleted successfully');
});

// Departments
const listDepartments = asyncHandler(async (req, res) => {
  const { page, limit, organizationId, officeId, search, status } = req.query;
  const data = await OrganizationService.listDepartments(Number(page), Number(limit), organizationId, officeId, search, status);
  sendList(res, req, data, 'Departments retrieved successfully');
});

const getDepartment = asyncHandler(async (req, res) => {
  const data = await OrganizationService.getDepartment(req.params.id);
  sendSuccess(res, data, 'Department retrieved successfully');
});

const createDepartment = asyncHandler(async (req, res) => {
  const data = await OrganizationService.createDepartment(req.body);
  sendSuccess(res, data, 'Department created successfully', 201);
});

const updateDepartment = asyncHandler(async (req, res) => {
  const data = await OrganizationService.updateDepartment(req.params.id, req.body);
  sendSuccess(res, data, 'Department updated successfully');
});

const deleteDepartment = asyncHandler(async (req, res) => {
  await OrganizationService.deleteDepartment(req.params.id);
  sendSuccess(res, null, 'Department deleted successfully');
});

module.exports = {
  listOrganizations,
  getOrganization,
  createOrganization,
  updateOrganization,
  deleteOrganization,
  listOffices,
  getOffice,
  createOffice,
  updateOffice,
  deleteOffice,
  listDepartments,
  getDepartment,
  createDepartment,
  updateDepartment,
  deleteDepartment,
};
