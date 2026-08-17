const { asyncHandler } = require('../../core/asyncHandler');
const { RoleService } = require('./role.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { PERMISSION_CATALOG } = require('../../utils/permissionCatalog');

/**
 * The permission tree the role editor renders. Served rather than duplicated in
 * the frontend so a permission added to the backend catalog shows up in the UI
 * on the next page load, with no second list to keep in step.
 *
 * `grantable` tells the UI which boxes this particular user is allowed to tick —
 * the same rule RoleService.assertGrantable enforces on write, sent up front so
 * the form can disable them instead of failing on save.
 */
const getPermissionCatalog = asyncHandler(async (req, res) => {
  sendSuccess(
    res,
    { modules: PERMISSION_CATALOG, grantable: RoleService.grantableFor(req.user) },
    'Permission catalog retrieved successfully'
  );
});

const listRoles = asyncHandler(async (req, res) => {
  const { page, limit, search, status } = req.query;
  const data = await RoleService.listRoles(Number(page), Number(limit), search, status);
  sendList(res, req, data, 'Roles retrieved successfully');
});

const getRole = asyncHandler(async (req, res) => {
  const data = await RoleService.getRole(req.params.id);
  sendSuccess(res, data, 'Role retrieved successfully');
});

const createRole = asyncHandler(async (req, res) => {
  const data = await RoleService.createRole(req.body, req.user);
  sendSuccess(res, data, 'Role created successfully', 201);
});

const updateRole = asyncHandler(async (req, res) => {
  const data = await RoleService.updateRole(req.params.id, req.body, req.user);
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
  getPermissionCatalog,
  listRoles,
  getRole,
  createRole,
  updateRole,
  deleteRole,
  getMembers,
  assignMember,
  removeMember,
};
