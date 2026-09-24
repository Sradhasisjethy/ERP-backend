const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories, assertCanSeeRecord } = require('../../core/salesScope');
const { ExpensesService } = require('./expenses.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

const list = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, category, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await ExpensesService.list(Number(page), Number(limit), { category, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Expenses retrieved successfully');
});
const get = asyncHandler(async (req, res) => {
  // The list is factory-scoped; this was not, so an expense at another plant
  // was readable — and cancellable — by id alone.
  const data = await ExpensesService.get(req.params.id);
  await assertCanSeeRecord(req, data, 'Expense not found');
  sendSuccess(res, maskRateFields(data, req), 'Expense retrieved successfully');
});
const createExpense = asyncHandler(async (req, res) => {
  sendSuccess(res, await ExpensesService.createExpense(req.body), 'Expense posted successfully', 201);
});
const cancelExpense = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await ExpensesService.get(req.params.id), 'Expense not found');
  sendSuccess(res, await ExpensesService.cancelExpense(req.params.id, req.body.reason), 'Expense cancelled successfully');
});

module.exports = { list, get, createExpense, cancelExpense };
