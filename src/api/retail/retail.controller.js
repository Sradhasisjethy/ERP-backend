const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories, assertCanUseFactory, assertCanSeeRecord } = require('../../core/salesScope');
const { hasPermission } = require('../../middlewares/authorize');
const { CounterSaleService } = require('./counterSale.service');
const { InvoicingService } = require('../invoicing/invoicing.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');
const { ForbiddenError } = require('../../core/AppError');

/**
 * Counter sales listing: the same sales invoices every other screen sees,
 * narrowed to the ones the counter raised. Deliberately not a separate table,
 * so a counter sale appears in the invoice register, the GST returns and the
 * receivables ageing without any of them knowing this module exists.
 */
const listCounterSales = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, customerPartyId, status, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await InvoicingService.listInvoices(Number(page) || 1, Number(limit) || 20, {
    customerPartyId,
    status,
    search,
    saleChannel: 'COUNTER',
    baseWhere,
  });
  sendList(res, req, maskRateFields(data, req), 'Counter sales retrieved successfully');
});

const getCounterSale = asyncHandler(async (req, res) => {
  const data = await InvoicingService.getInvoice(req.params.id);
  await assertCanSeeRecord(req, data, 'Counter sale not found');
  sendSuccess(res, maskRateFields(data, req), 'Counter sale retrieved successfully');
});

/**
 * What the sale would come to. Commits nothing, so it is gated on read rather
 * than create — a clerk pricing up a basket has not sold anything yet.
 */
const quoteCounterSale = asyncHandler(async (req, res) => {
  await assertCanUseFactory(req, req.body.factoryId);
  // Mirrors the sales-order flow: whether this user may take a mandatory
  // accessory off the sale is a permission, not a request field.
  const canOverrideMandatory = hasPermission(req.user, 'SALES_BUNDLE_OVERRIDE_MANDATORY');
  const data = await CounterSaleService.quote({ ...req.body, canOverrideMandatory });
  sendSuccess(res, maskRateFields(data, req), 'Counter sale quoted successfully');
});

const createCounterSale = asyncHandler(async (req, res) => {
  // BR-29: a counter sale issues stock from a named factory, so the caller must
  // be allowed to act on that factory before anything else is read.
  await assertCanUseFactory(req, req.body.factoryId);

  // Taking money is a separate grant from raising an invoice. The route gate
  // requires INVOICE_CREATE because every counter sale produces an invoice;
  // PAYMENT_CREATE is only demanded when money actually changes hands, so a
  // clerk who may bill but not handle cash can still raise a credit sale.
  if (req.body.payment && !hasPermission(req.user, 'PAYMENT_CREATE')) {
    throw new ForbiddenError('Recording a payment on a counter sale requires the Payments create permission');
  }

  const canOverrideMandatory = hasPermission(req.user, 'SALES_BUNDLE_OVERRIDE_MANDATORY');
  const data = await CounterSaleService.createCounterSale({ ...req.body, canOverrideMandatory });
  sendSuccess(res, maskRateFields(data, req), 'Counter sale completed successfully', 201);
});

module.exports = { listCounterSales, getCounterSale, createCounterSale, quoteCounterSale };
