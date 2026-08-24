const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories, assertCanSeeRecord } = require('../../core/salesScope');
const { DispatchService } = require('./dispatch.service');
const { renderChallanPdf } = require('./challanPdf.service');
const { sendSuccess, sendList } = require('../../utils/response');

const listChallans = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, salesOrderId, status, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await DispatchService.listChallans(Number(page), Number(limit), { salesOrderId, status, search, baseWhere });
  sendList(res, req, data, 'Delivery challans retrieved successfully');
});

const getChallan = asyncHandler(async (req, res) => {
  const data = await DispatchService.getChallan(req.params.id);
  await assertCanSeeRecord(req, data, 'Delivery challan not found');
  sendSuccess(res, data, 'Delivery challan retrieved successfully');
});

const createChallan = asyncHandler(async (req, res) => {
  // The challan inherits its factory from the order, so access is checked
  // against the order the caller is dispatching.
  const { SalesService } = require('../sales/sales.service');
  await assertCanSeeRecord(req, await SalesService.getSalesOrder(req.body.salesOrderId), 'Sales order not found');
  const data = await DispatchService.createChallan(req.body);
  sendSuccess(res, data, 'Delivery challan dispatched successfully', 201);
});

const cancelChallan = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await DispatchService.getChallan(req.params.id), 'Delivery challan not found');
  const data = await DispatchService.cancelChallan(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Delivery challan cancelled successfully');
});

const printChallan = asyncHandler(async (req, res) => {
  const challan = await DispatchService.getChallan(req.params.id);
  const doc = renderChallanPdf(challan, { format: req.query.format });

  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${challan.challanNumber.replace(/\//g, '-')}.pdf"`);
  doc.pipe(res);
  doc.end();
});

module.exports = { listChallans, getChallan, createChallan, cancelChallan, printChallan };
