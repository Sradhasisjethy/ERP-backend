const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories, assertCanUseFactory, assertCanSeeRecord } = require('../../core/salesScope');
const { PaymentsService } = require('./payments.service');
const { ChequeService } = require('./cheque.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

const listReceipts = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, customerPartyId, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await PaymentsService.listReceipts(Number(page), Number(limit), { customerPartyId, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Receipts retrieved successfully');
});
const getReceipt = asyncHandler(async (req, res) => {
  const data = await PaymentsService.getReceipt(req.params.id);
  await assertCanSeeRecord(req, data, 'Receipt not found');
  sendSuccess(res, maskRateFields(data, req), 'Receipt retrieved successfully');
});
const createReceipt = asyncHandler(async (req, res) => {
  await assertCanUseFactory(req, req.body.factoryId);
  sendSuccess(res, await PaymentsService.createReceipt(req.body), 'Receipt posted successfully', 201);
});
const cancelReceipt = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await PaymentsService.getReceipt(req.params.id), 'Receipt not found');
  sendSuccess(res, await PaymentsService.cancelReceipt(req.params.id, req.body.reason), 'Receipt cancelled successfully');
});

const listPayments = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, partyId, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await PaymentsService.listPayments(Number(page), Number(limit), { partyId, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Payments retrieved successfully');
});
const getPayment = asyncHandler(async (req, res) => {
  const data = await PaymentsService.getPayment(req.params.id);
  await assertCanSeeRecord(req, data, 'Payment not found');
  sendSuccess(res, maskRateFields(data, req), 'Payment retrieved successfully');
});
const createPayment = asyncHandler(async (req, res) => {
  await assertCanUseFactory(req, req.body.factoryId);
  sendSuccess(res, await PaymentsService.createPayment(req.body), 'Payment posted successfully', 201);
});
const cancelPayment = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await PaymentsService.getPayment(req.params.id), 'Payment not found');
  sendSuccess(res, await PaymentsService.cancelPayment(req.params.id, req.body.reason), 'Payment cancelled successfully');
});

// --- FR-M18-7: cheque lifecycle ---
const listCheques = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, status, direction, partyId, search } = req.query;
  const data = await ChequeService.list(Number(page), Number(limit), { factoryId, status, direction, partyId, search });
  sendList(res, req, maskRateFields(data, req, ['amountPaise', 'bankChargesPaise']), 'Cheques retrieved successfully');
});
const getCheque = asyncHandler(async (req, res) => {
  sendSuccess(res, maskRateFields(await ChequeService.get(req.params.id), req, ['amountPaise', 'bankChargesPaise']), 'Cheque retrieved successfully');
});
const presentCheque = asyncHandler(async (req, res) => {
  sendSuccess(res, await ChequeService.present(req.params.id, req.body), 'Cheque marked presented');
});
const clearCheque = asyncHandler(async (req, res) => {
  sendSuccess(res, await ChequeService.clear(req.params.id, req.body), 'Cheque cleared');
});
const bounceCheque = asyncHandler(async (req, res) => {
  sendSuccess(res, await ChequeService.bounce(req.params.id, req.body), 'Cheque marked bounced and the underlying entry reversed');
});
const cancelCheque = asyncHandler(async (req, res) => {
  sendSuccess(res, await ChequeService.cancel(req.params.id, req.body.reason), 'Cheque cancelled');
});

module.exports = {
  listCheques, getCheque, presentCheque, clearCheque, bounceCheque, cancelCheque, listReceipts, getReceipt, createReceipt, cancelReceipt, listPayments, getPayment, createPayment, cancelPayment };
