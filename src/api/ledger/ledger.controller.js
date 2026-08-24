const { asyncHandler } = require('../../core/asyncHandler');
const { LedgerService } = require('./ledger.service');
const { scopeListToFactories, assertCanUseFactory } = require('../../core/salesScope');
const { getAllowedFactoryIds } = require('../../core/factoryAccess');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields, hasViewRates } = require('../../utils/fieldMasking');

const listAccounts = asyncHandler(async (req, res) => {
  const data = await LedgerService.listAccounts();
  sendSuccess(res, data, 'Chart of accounts retrieved successfully');
});

const getTrialBalance = asyncHandler(async (req, res) => {
  // BR-29: a trial balance is location data. Asking for a factory the caller
  // has no access to is refused; asking for none restricts it to theirs
  // instead of returning the whole tenant's books.
  if (req.query.factoryId) await assertCanUseFactory(req, req.query.factoryId);
  const allowed = await getAllowedFactoryIds(req);
  const data = await LedgerService.getTrialBalance(req.query.factoryId, allowed);
  sendSuccess(res, maskRateFields(data, req, ['totalDebitPaise', 'totalCreditPaise', 'balancePaise']), 'Trial balance retrieved successfully');
});

const getPartyLedger = asyncHandler(async (req, res) => {
  const { page, limit } = req.query;
  const ledger = await LedgerService.getPartyLedger(req.params.partyId, { page: Number(page), limit: Number(limit) });
  const outstanding = await LedgerService.getPartyOutstanding(req.params.partyId);

  // Composite shape (paginated rows plus top-level summary figures) doesn't
  // fit maskRateFields' generic {rows} or flat-object cases, so every money
  // field is masked explicitly here rather than forcing the helper to guess.
  // The running balance and the opening/closing figures are money too — they
  // were the fields most easily left behind when this was one line.
  const MONEY_ROW_FIELDS = ['debitPaise', 'creditPaise', 'runningBalancePaise'];
  const visible = hasViewRates(req);

  sendList(
    res,
    req,
    {
      rows: maskRateFields(ledger.rows, req, MONEY_ROW_FIELDS),
      count: ledger.count,
      outstandingPaise: visible ? outstanding : null,
      openingBalancePaise: visible ? ledger.openingBalancePaise : null,
      closingBalancePaise: visible ? ledger.closingBalancePaise : null,
    },
    'Party ledger retrieved successfully'
  );
});

const getCashBook = asyncHandler(async (req, res) => {
  const { factoryId, from, to, accountKey } = req.query;
  await assertCanUseFactory(req, factoryId);
  const book = await LedgerService.getCashBook(factoryId, { from, to, accountKey });

  const visible = hasViewRates(req);
  sendSuccess(
    res,
    {
      ...book,
      openingBalancePaise: visible ? book.openingBalancePaise : null,
      closingBalancePaise: visible ? book.closingBalancePaise : null,
      totalInPaise: visible ? book.totalInPaise : null,
      totalOutPaise: visible ? book.totalOutPaise : null,
      rows: maskRateFields(book.rows, req, ['debitPaise', 'creditPaise', 'runningBalancePaise']),
    },
    'Cash book retrieved successfully'
  );
});

module.exports = { listAccounts, getTrialBalance, getPartyLedger, getCashBook };
