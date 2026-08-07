const { asyncHandler } = require('../../core/asyncHandler');
const { userService } = require('./user.service');
const { sendSuccess } = require('../../utils/response');

const list = asyncHandler(async (req, res) => {
  const result = await userService.list(req.query);
  sendSuccess(res, result);
});

const getById = asyncHandler(async (req, res) => {
  const user = await userService.getById(req.params.id);
  sendSuccess(res, user);
});

const create = asyncHandler(async (req, res) => {
  const user = await userService.create(req.body);
  sendSuccess(res, user, 'User created successfully', 201);
});

const update = asyncHandler(async (req, res) => {
  const user = await userService.update(req.params.id, req.body);
  sendSuccess(res, user, 'User updated successfully');
});

const deleteUser = asyncHandler(async (req, res) => {
  await userService.delete(req.params.id);
  sendSuccess(res, null, 'Employee deleted');
});

module.exports = { list, getById, create, update, deleteUser };
