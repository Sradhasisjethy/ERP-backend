const { asyncHandler } = require('../../core/asyncHandler');
const { PurchasingService } = require('./purchasing.service');
const { IndentService } = require('./indent.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

// Purchase Orders
const listPurchaseOrders = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, vendorPartyId, status, search } = req.query;
  const data = await PurchasingService.listPurchaseOrders(Number(page), Number(limit), { factoryId, vendorPartyId, status, search });
  sendList(res, req, maskRateFields(data, req), 'Purchase orders retrieved successfully');
});
const getPurchaseOrder = asyncHandler(async (req, res) => {
  const data = await PurchasingService.getPurchaseOrder(req.params.id);
  sendSuccess(res, maskRateFields(data, req), 'Purchase order retrieved successfully');
});
const createPurchaseOrder = asyncHandler(async (req, res) => {
  const data = await PurchasingService.createPurchaseOrder(req.body);
  sendSuccess(res, data, 'Purchase order created successfully', 201);
});
const confirmPurchaseOrder = asyncHandler(async (req, res) => {
  const data = await PurchasingService.confirmPurchaseOrder(req.params.id);
  sendSuccess(res, data, 'Purchase order confirmed successfully');
});
const cancelPurchaseOrder = asyncHandler(async (req, res) => {
  const data = await PurchasingService.cancelPurchaseOrder(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Purchase order cancelled successfully');
});

// Goods Receipt
const listGoodsReceipts = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, vendorPartyId, purchaseOrderId, search } = req.query;
  const data = await PurchasingService.listGoodsReceipts(Number(page), Number(limit), { factoryId, vendorPartyId, purchaseOrderId, search });
  sendList(res, req, maskRateFields(data, req), 'Goods receipts retrieved successfully');
});
const getGoodsReceipt = asyncHandler(async (req, res) => {
  const data = await PurchasingService.getGoodsReceipt(req.params.id);
  sendSuccess(res, maskRateFields(data, req), 'Goods receipt retrieved successfully');
});
const createGoodsReceipt = asyncHandler(async (req, res) => {
  const data = await PurchasingService.createGoodsReceipt(req.body);
  sendSuccess(res, data, 'Goods receipt posted successfully', 201);
});

// Purchase Invoice
const listPurchaseInvoices = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, vendorPartyId, paymentStatus, search } = req.query;
  const data = await PurchasingService.listPurchaseInvoices(Number(page), Number(limit), { factoryId, vendorPartyId, paymentStatus, search });
  sendList(res, req, maskRateFields(data, req), 'Purchase invoices retrieved successfully');
});
const getPurchaseInvoice = asyncHandler(async (req, res) => {
  const data = await PurchasingService.getPurchaseInvoice(req.params.id);
  sendSuccess(res, maskRateFields(data, req), 'Purchase invoice retrieved successfully');
});
const createPurchaseInvoice = asyncHandler(async (req, res) => {
  const data = await PurchasingService.createPurchaseInvoice(req.body);
  sendSuccess(res, data, 'Purchase invoice created successfully', 201);
});
const updatePaymentStatus = asyncHandler(async (req, res) => {
  const data = await PurchasingService.updatePurchaseInvoicePaymentStatus(req.params.id, req.body.paymentStatus);
  sendSuccess(res, data, 'Payment status updated successfully');
});

// --- FR-M11-1: purchase indents ---
const listIndents = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, status, search } = req.query;
  sendList(res, req, await IndentService.list(Number(page), Number(limit), { factoryId, status, search }), 'Purchase indents retrieved successfully');
});
const getIndent = asyncHandler(async (req, res) => {
  sendSuccess(res, await IndentService.get(req.params.id), 'Purchase indent retrieved successfully');
});
const createIndent = asyncHandler(async (req, res) => {
  sendSuccess(res, await IndentService.create(req.body), 'Purchase indent raised successfully', 201);
});
const approveIndent = asyncHandler(async (req, res) => {
  sendSuccess(res, await IndentService.approve(req.params.id), 'Purchase indent approved');
});
const rejectIndent = asyncHandler(async (req, res) => {
  sendSuccess(res, await IndentService.reject(req.params.id, req.body.reason), 'Purchase indent rejected');
});
const cancelIndent = asyncHandler(async (req, res) => {
  sendSuccess(res, await IndentService.cancel(req.params.id, req.body.reason), 'Purchase indent cancelled');
});
const convertIndent = asyncHandler(async (req, res) => {
  sendSuccess(res, await IndentService.convertToPurchaseOrder(req.params.id, req.body), 'Purchase order created from indent', 201);
});

// --- FR-M11-6: three-way match ---
const threeWayMatch = asyncHandler(async (req, res) => {
  const data = await IndentService.threeWayMatch(req.params.id);
  // BR-27: the match report is money end to end.
  sendSuccess(res, maskRateFields(data, req, ['receiptValuePaise', 'invoiceValuePaise', 'valueVariancePaise']), 'Three-way match retrieved successfully');
});

module.exports = {
  listIndents, getIndent, createIndent, approveIndent, rejectIndent, cancelIndent, convertIndent, threeWayMatch,
  listPurchaseOrders, getPurchaseOrder, createPurchaseOrder, confirmPurchaseOrder, cancelPurchaseOrder,
  listGoodsReceipts, getGoodsReceipt, createGoodsReceipt,
  listPurchaseInvoices, getPurchaseInvoice, createPurchaseInvoice, updatePaymentStatus,
};
