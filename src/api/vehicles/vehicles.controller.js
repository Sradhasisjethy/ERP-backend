const { asyncHandler } = require('../../core/asyncHandler');
const { VehicleService } = require('./vehicles.service');
const { sendSuccess, sendList } = require('../../utils/response');

const listVehicles = asyncHandler(async (req, res) => {
  const { page, limit, status, vehicleType, ownership, search, sortBy, sortDir } = req.query;
  const data = await VehicleService.list(Number(page), Number(limit), {
    status, vehicleType, ownership, search, sortBy, sortDir,
  });
  sendList(res, req, data, 'Vehicles retrieved successfully');
});

const getVehicle = asyncHandler(async (req, res) => {
  sendSuccess(res, await VehicleService.get(req.params.id), 'Vehicle retrieved successfully');
});

const createVehicle = asyncHandler(async (req, res) => {
  sendSuccess(res, await VehicleService.create(req.body), 'Vehicle created successfully', 201);
});

const updateVehicle = asyncHandler(async (req, res) => {
  sendSuccess(res, await VehicleService.update(req.params.id, req.body), 'Vehicle updated successfully');
});

const deleteVehicle = asyncHandler(async (req, res) => {
  sendSuccess(res, await VehicleService.remove(req.params.id), 'Vehicle deactivated successfully');
});

module.exports = { listVehicles, getVehicle, createVehicle, updateVehicle, deleteVehicle };
