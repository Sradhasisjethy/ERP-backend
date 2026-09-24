const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToEitherFactory, assertCanSeeTransfer } = require('../../core/salesScope');
const { TransferService } = require('./transfer.service');
const { sendSuccess, sendList } = require('../../utils/response');

const listTransfers = asyncHandler(async (req, res) => {
  const { page, limit, fromFactoryId, toFactoryId, status, search } = req.query;
  // scopeListToFactories was imported here but never called, and would have
  // done nothing anyway: a transfer has no plain `factoryId` for it to filter
  // on. Every plant's transfers were listed to everyone.
  const baseWhere = await scopeListToEitherFactory(req, {});
  const data = await TransferService.listTransfers(Number(page), Number(limit), { fromFactoryId, toFactoryId, status, search, baseWhere });
  sendList(res, req, data, 'Stock transfers retrieved successfully');
});

const getTransfer = asyncHandler(async (req, res) => {
  const data = await TransferService.getTransfer(req.params.id);
  await assertCanSeeTransfer(req, data, 'Stock transfer not found');
  sendSuccess(res, data, 'Stock transfer retrieved successfully');
});

const initiateTransfer = asyncHandler(async (req, res) => {
  const data = await TransferService.initiateTransfer(req.body);
  sendSuccess(res, data, 'Stock transfer initiated successfully', 201);
});

const receiveTransfer = asyncHandler(async (req, res) => {
  // Receiving moves stock, so it needs the record check, not just the
  // enforceFactoryScope middleware (which only inspects a named factoryId).
  await assertCanSeeTransfer(req, await TransferService.getTransfer(req.params.id), 'Stock transfer not found');
  const data = await TransferService.receiveTransfer(req.params.id, req.body);
  sendSuccess(res, data, 'Stock transfer received successfully');
});

const cancelTransfer = asyncHandler(async (req, res) => {
  await assertCanSeeTransfer(req, await TransferService.getTransfer(req.params.id), 'Stock transfer not found');
  const data = await TransferService.cancelTransfer(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Stock transfer cancelled successfully');
});

module.exports = { listTransfers, getTransfer, initiateTransfer, receiveTransfer, cancelTransfer };
