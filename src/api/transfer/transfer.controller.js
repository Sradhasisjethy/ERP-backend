const { asyncHandler } = require('../../core/asyncHandler');
const { TransferService } = require('./transfer.service');
const { sendSuccess, sendList } = require('../../utils/response');

const listTransfers = asyncHandler(async (req, res) => {
  const { page, limit, fromFactoryId, toFactoryId, status, search } = req.query;
  const data = await TransferService.listTransfers(Number(page), Number(limit), { fromFactoryId, toFactoryId, status, search });
  sendList(res, req, data, 'Stock transfers retrieved successfully');
});

const getTransfer = asyncHandler(async (req, res) => {
  const data = await TransferService.getTransfer(req.params.id);
  sendSuccess(res, data, 'Stock transfer retrieved successfully');
});

const initiateTransfer = asyncHandler(async (req, res) => {
  const data = await TransferService.initiateTransfer(req.body);
  sendSuccess(res, data, 'Stock transfer initiated successfully', 201);
});

const receiveTransfer = asyncHandler(async (req, res) => {
  const data = await TransferService.receiveTransfer(req.params.id, req.body);
  sendSuccess(res, data, 'Stock transfer received successfully');
});

const cancelTransfer = asyncHandler(async (req, res) => {
  const data = await TransferService.cancelTransfer(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Stock transfer cancelled successfully');
});

module.exports = { listTransfers, getTransfer, initiateTransfer, receiveTransfer, cancelTransfer };
