const { asyncHandler } = require('../../core/asyncHandler');
const { InvoicingService } = require('./invoicing.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

const listInvoices = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, customerPartyId, status, search } = req.query;
  const data = await InvoicingService.listInvoices(Number(page), Number(limit), { factoryId, customerPartyId, status, search });
  sendList(res, req, maskRateFields(data, req), 'Sales invoices retrieved successfully');
});

const getInvoice = asyncHandler(async (req, res) => {
  const data = await InvoicingService.getInvoice(req.params.id);
  sendSuccess(res, maskRateFields(data, req), 'Sales invoice retrieved successfully');
});

const createInvoice = asyncHandler(async (req, res) => {
  const data = await InvoicingService.createInvoiceFromChallans(req.body);
  sendSuccess(res, data, 'Sales invoice created successfully', 201);
});

const cancelInvoice = asyncHandler(async (req, res) => {
  const data = await InvoicingService.cancelInvoice(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Sales invoice cancelled successfully');
});

module.exports = { listInvoices, getInvoice, createInvoice, cancelInvoice };
