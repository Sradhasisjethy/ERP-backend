const { asyncHandler } = require('../../core/asyncHandler');
const { ReturnsService } = require('./returns.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

// Sales Return
const listSalesReturns = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, customerPartyId, search } = req.query;
  const data = await ReturnsService.listSalesReturns(Number(page), Number(limit), { factoryId, customerPartyId, search });
  sendList(res, req, maskRateFields(data, req), 'Sales returns retrieved successfully');
});
const getSalesReturn = asyncHandler(async (req, res) => {
  sendSuccess(res, maskRateFields(await ReturnsService.getSalesReturn(req.params.id), req), 'Sales return retrieved successfully');
});
const createSalesReturn = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.createSalesReturn(req.body), 'Sales return posted successfully', 201);
});
const cancelSalesReturn = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.cancelSalesReturn(req.params.id, req.body.reason), 'Sales return cancelled successfully');
});

// Purchase Return
const listPurchaseReturns = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, vendorPartyId, search } = req.query;
  const data = await ReturnsService.listPurchaseReturns(Number(page), Number(limit), { factoryId, vendorPartyId, search });
  sendList(res, req, maskRateFields(data, req), 'Purchase returns retrieved successfully');
});
const getPurchaseReturn = asyncHandler(async (req, res) => {
  sendSuccess(res, maskRateFields(await ReturnsService.getPurchaseReturn(req.params.id), req), 'Purchase return retrieved successfully');
});
const createPurchaseReturn = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.createPurchaseReturn(req.body), 'Purchase return posted successfully', 201);
});
const cancelPurchaseReturn = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.cancelPurchaseReturn(req.params.id, req.body.reason), 'Purchase return cancelled successfully');
});

// Credit Note
const listCreditNotes = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, customerPartyId, search } = req.query;
  const data = await ReturnsService.listCreditNotes(Number(page), Number(limit), { factoryId, customerPartyId, search });
  sendList(res, req, maskRateFields(data, req), 'Credit notes retrieved successfully');
});
const getCreditNote = asyncHandler(async (req, res) => {
  sendSuccess(res, maskRateFields(await ReturnsService.getCreditNote(req.params.id), req), 'Credit note retrieved successfully');
});
const createCreditNote = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.createCreditNote(req.body), 'Credit note posted successfully', 201);
});
const cancelCreditNote = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.cancelCreditNote(req.params.id, req.body.reason), 'Credit note cancelled successfully');
});

// Debit Note
const listDebitNotes = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, vendorPartyId, search } = req.query;
  const data = await ReturnsService.listDebitNotes(Number(page), Number(limit), { factoryId, vendorPartyId, search });
  sendList(res, req, maskRateFields(data, req), 'Debit notes retrieved successfully');
});
const getDebitNote = asyncHandler(async (req, res) => {
  sendSuccess(res, maskRateFields(await ReturnsService.getDebitNote(req.params.id), req), 'Debit note retrieved successfully');
});
const createDebitNote = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.createDebitNote(req.body), 'Debit note posted successfully', 201);
});
const cancelDebitNote = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.cancelDebitNote(req.params.id, req.body.reason), 'Debit note cancelled successfully');
});

module.exports = {
  listSalesReturns, getSalesReturn, createSalesReturn, cancelSalesReturn,
  listPurchaseReturns, getPurchaseReturn, createPurchaseReturn, cancelPurchaseReturn,
  listCreditNotes, getCreditNote, createCreditNote, cancelCreditNote,
  listDebitNotes, getDebitNote, createDebitNote, cancelDebitNote,
};
