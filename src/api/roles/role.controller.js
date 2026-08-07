const { asyncHandler } = require('../../core/asyncHandler');
const { RoleService } = require('./role.service');
const { sendSuccess } = require('../../utils/response');

const listRoles = asyncHandler(async (req, res) => {
  const { page, limit, search, status } = req.query;
  const data = await RoleService.listRoles(Number(page), Number(limit), search, status);
  sendSuccess(res, data, 'Roles retrieved successfully');
});

const getRole = asyncHandler(async (req, res) => {
  const data = await RoleService.getRole(req.params.id);
  sendSuccess(res, data, 'Role retrieved successfully');
});

const createRole = asyncHandler(async (req, res) => {
  const data = await RoleService.createRole(req.body);
  sendSuccess(res, data, 'Role created successfully', 201);
});

const updateRole = asyncHandler(async (req, res) => {
  const data = await RoleService.updateRole(req.params.id, req.body);
  sendSuccess(res, data, 'Role updated successfully');
});

const deleteRole = asyncHandler(async (req, res) => {
  await RoleService.deleteRole(req.params.id);
  sendSuccess(res, null, 'Role deleted successfully');
});

const getMembers = asyncHandler(async (req, res) => {
  const data = await RoleService.getMembers(req.params.id);
  sendSuccess(res, data, 'Members retrieved successfully');
});

const assignMember = asyncHandler(async (req, res) => {
  const { employeeId } = req.body;
  const data = await RoleService.assignMember(req.params.id, employeeId);
  sendSuccess(res, data, 'Member assigned successfully', 201);
});

const removeMember = asyncHandler(async (req, res) => {
  await RoleService.removeMember(req.params.id, req.params.employeeId);
  sendSuccess(res, null, 'Member removed successfully');
});

module.exports = {
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  getMembers,
  assignMember,
  removeMember,
};
