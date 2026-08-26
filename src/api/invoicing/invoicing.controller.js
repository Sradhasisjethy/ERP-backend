const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories, assertCanSeeRecord } = require('../../core/salesScope');
const { InvoicingService } = require('./invoicing.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

const listInvoices = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, customerPartyId, status, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await InvoicingService.listInvoices(Number(page), Number(limit), { customerPartyId, status, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Sales invoices retrieved successfully');
});

const getInvoice = asyncHandler(async (req, res) => {
  const data = await InvoicingService.getInvoice(req.params.id);
  await assertCanSeeRecord(req, data, 'Sales invoice not found');
  sendSuccess(res, maskRateFields(data, req), 'Sales invoice retrieved successfully');
});

const createInvoice = asyncHandler(async (req, res) => {
  // The invoice inherits its factory from the challans, so access is checked
  // against the first one named — the service already refuses a mixed-factory set.
  const { DispatchService } = require('../dispatch/dispatch.service');
  await assertCanSeeRecord(req, await DispatchService.getChallan(req.body.challanIds[0]), 'Delivery challan not found');
  const data = await InvoicingService.createInvoiceFromChallans(req.body);
  sendSuccess(res, data, 'Sales invoice created successfully', 201);
});

const cancelInvoice = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await InvoicingService.getInvoice(req.params.id), 'Sales invoice not found');
  const data = await InvoicingService.cancelInvoice(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Sales invoice cancelled successfully');
});

module.exports = { listInvoices, getInvoice, createInvoice, cancelInvoice };
