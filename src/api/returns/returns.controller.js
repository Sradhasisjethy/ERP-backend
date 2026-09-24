const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories, assertCanUseFactory, assertCanSeeRecord } = require('../../core/salesScope');
const { ReturnsService } = require('./returns.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

/**
 * BR-29 for the four return documents.
 *
 * The lists here were all scoped through scopeListToFactories, but every
 * single-record handler took a bare `:id` and acted on it — so a user at one
 * plant could open, and more importantly *cancel*, another plant's sales
 * return, purchase return, credit note or debit note. Cancelling reverses stock
 * and ledger entries, which makes this a cross-location write, not just a read.
 *
 * 404 rather than 403, as everywhere else: see core/salesScope.js.
 */
const guard = (fetch, subject) => async (req) =>
  assertCanSeeRecord(req, await fetch(req.params.id), `${subject} not found`);

const guardSalesReturn = guard((id) => ReturnsService.getSalesReturn(id), 'Sales return');
const guardPurchaseReturn = guard((id) => ReturnsService.getPurchaseReturn(id), 'Purchase return');
const guardCreditNote = guard((id) => ReturnsService.getCreditNote(id), 'Credit note');
const guardDebitNote = guard((id) => ReturnsService.getDebitNote(id), 'Debit note');

// Sales Return
const listSalesReturns = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, customerPartyId, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ReturnsService.listSalesReturns(Number(page), Number(limit), { customerPartyId, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Sales returns retrieved successfully');
});
const getSalesReturn = asyncHandler(async (req, res) => {
  const data = await ReturnsService.getSalesReturn(req.params.id);
  await assertCanSeeRecord(req, data, 'Sales return not found');
  sendSuccess(res, maskRateFields(data, req), 'Sales return retrieved successfully');
});
/** What a customer can send back, for the return screen to pick from. */
const returnableItems = asyncHandler(async (req, res) => {
  const { factoryId, customerPartyId } = req.query;
  await assertCanUseFactory(req, factoryId);
  const data = await ReturnsService.returnableItems({ factoryId, customerPartyId });
  sendSuccess(
    res,
    {
      ...data,
      invoices: data.invoices.map((invoice) => ({
        ...maskRateFields(invoice, req),
        lines: maskRateFields(invoice.lines, req),
      })),
    },
    'Returnable items retrieved successfully'
  );
});

const createSalesReturn = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.createSalesReturn(req.body), 'Sales return posted successfully', 201);
});
const cancelSalesReturn = asyncHandler(async (req, res) => {
  await guardSalesReturn(req);
  sendSuccess(res, await ReturnsService.cancelSalesReturn(req.params.id, req.body.reason), 'Sales return cancelled successfully');
});

// Purchase Return
const listPurchaseReturns = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, vendorPartyId, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ReturnsService.listPurchaseReturns(Number(page), Number(limit), { vendorPartyId, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Purchase returns retrieved successfully');
});
const getPurchaseReturn = asyncHandler(async (req, res) => {
  const data = await ReturnsService.getPurchaseReturn(req.params.id);
  await assertCanSeeRecord(req, data, 'Purchase return not found');
  sendSuccess(res, maskRateFields(data, req), 'Purchase return retrieved successfully');
});
const createPurchaseReturn = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.createPurchaseReturn(req.body), 'Purchase return posted successfully', 201);
});
const cancelPurchaseReturn = asyncHandler(async (req, res) => {
  await guardPurchaseReturn(req);
  sendSuccess(res, await ReturnsService.cancelPurchaseReturn(req.params.id, req.body.reason), 'Purchase return cancelled successfully');
});

// Credit Note
const listCreditNotes = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, customerPartyId, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ReturnsService.listCreditNotes(Number(page), Number(limit), { customerPartyId, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Credit notes retrieved successfully');
});
const getCreditNote = asyncHandler(async (req, res) => {
  const data = await ReturnsService.getCreditNote(req.params.id);
  await assertCanSeeRecord(req, data, 'Credit note not found');
  sendSuccess(res, maskRateFields(data, req), 'Credit note retrieved successfully');
});
const createCreditNote = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.createCreditNote(req.body), 'Credit note posted successfully', 201);
});
const cancelCreditNote = asyncHandler(async (req, res) => {
  await guardCreditNote(req);
  sendSuccess(res, await ReturnsService.cancelCreditNote(req.params.id, req.body.reason), 'Credit note cancelled successfully');
});

// Debit Note
const listDebitNotes = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, vendorPartyId, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ReturnsService.listDebitNotes(Number(page), Number(limit), { vendorPartyId, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Debit notes retrieved successfully');
});
const getDebitNote = asyncHandler(async (req, res) => {
  const data = await ReturnsService.getDebitNote(req.params.id);
  await assertCanSeeRecord(req, data, 'Debit note not found');
  sendSuccess(res, maskRateFields(data, req), 'Debit note retrieved successfully');
});
const createDebitNote = asyncHandler(async (req, res) => {
  sendSuccess(res, await ReturnsService.createDebitNote(req.body), 'Debit note posted successfully', 201);
});
const cancelDebitNote = asyncHandler(async (req, res) => {
  await guardDebitNote(req);
  sendSuccess(res, await ReturnsService.cancelDebitNote(req.params.id, req.body.reason), 'Debit note cancelled successfully');
});

module.exports = {
  returnableItems,
  listSalesReturns, getSalesReturn, createSalesReturn, cancelSalesReturn,
  listPurchaseReturns, getPurchaseReturn, createPurchaseReturn, cancelPurchaseReturn,
  listCreditNotes, getCreditNote, createCreditNote, cancelCreditNote,
  listDebitNotes, getDebitNote, createDebitNote, cancelDebitNote,
};
