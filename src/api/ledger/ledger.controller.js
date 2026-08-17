const { asyncHandler } = require('../../core/asyncHandler');
const { LedgerService } = require('./ledger.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields, hasViewRates } = require('../../utils/fieldMasking');

const listAccounts = asyncHandler(async (req, res) => {
  const data = await LedgerService.listAccounts();
  sendSuccess(res, data, 'Chart of accounts retrieved successfully');
});

const getTrialBalance = asyncHandler(async (req, res) => {
  const data = await LedgerService.getTrialBalance(req.query.factoryId);
  sendSuccess(res, maskRateFields(data, req, ['totalDebitPaise', 'totalCreditPaise', 'balancePaise']), 'Trial balance retrieved successfully');
});

const getPartyLedger = asyncHandler(async (req, res) => {
  const { page, limit, search } = req.query;
  const [ledger, outstanding] = await Promise.all([
    LedgerService.getPartyLedger(req.params.partyId, { page: Number(page), limit: Number(limit) }),
    LedgerService.getPartyOutstanding(req.params.partyId),
  ]);
  // Composite shape (paginated rows + a top-level summary field) doesn't fit
  // maskRateFields' generic {rows} or flat-object cases, so both halves are
  // masked explicitly here rather than forcing the helper to guess.
  const maskedRows = maskRateFields(ledger.rows, req, ['debitPaise', 'creditPaise']);
  const maskedOutstanding = hasViewRates(req) ? outstanding : null;
  sendList(res, req, { rows: maskedRows, count: ledger.count, outstandingPaise: maskedOutstanding }, 'Party ledger retrieved successfully');
});

const getCashBook = asyncHandler(async (req, res) => {
  const { factoryId, from, to, accountKey } = req.query;
  const data = await LedgerService.getCashBook(factoryId, { from, to, accountKey });
  sendSuccess(res, maskRateFields(data, req, ['debitPaise', 'creditPaise', 'runningBalancePaise']), 'Cash book retrieved successfully');
});

module.exports = { listAccounts, getTrialBalance, getPartyLedger, getCashBook };
