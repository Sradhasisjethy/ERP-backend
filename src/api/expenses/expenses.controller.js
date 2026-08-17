const { asyncHandler } = require('../../core/asyncHandler');
const { ExpensesService } = require('./expenses.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

const list = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, category, search } = req.query;
  const data = await ExpensesService.list(Number(page), Number(limit), { factoryId, category, search });
  sendList(res, req, maskRateFields(data, req, ['amountPaise']), 'Expenses retrieved successfully');
});
const get = asyncHandler(async (req, res) => {
  sendSuccess(res, maskRateFields(await ExpensesService.get(req.params.id), req, ['amountPaise']), 'Expense retrieved successfully');
});
const createExpense = asyncHandler(async (req, res) => {
  sendSuccess(res, await ExpensesService.createExpense(req.body), 'Expense posted successfully', 201);
});
const cancelExpense = asyncHandler(async (req, res) => {
  sendSuccess(res, await ExpensesService.cancelExpense(req.params.id, req.body.reason), 'Expense cancelled successfully');
});

module.exports = { list, get, createExpense, cancelExpense };
