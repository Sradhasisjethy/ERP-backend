const { asyncHandler } = require('../../core/asyncHandler');
const { LedgerService } = require('./ledger.service');
const { AccountsService } = require('./accounts.service');
const { JournalVoucherService } = require('./journalVoucher.service');
const { ACCOUNT_GROUPS } = require('./accountGroups');
const { FinancialStatementsService } = require('./financialStatements.service');
const { ForbiddenError } = require('../../core/AppError');
const { scopeListToFactories, assertCanUseFactory, assertCanSeeRecord } = require('../../core/salesScope');
const { getAllowedFactoryIds } = require('../../core/factoryAccess');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields, hasViewRates } = require('../../utils/fieldMasking');

/**
 * The chart of accounts, with each account's statement group and money kind
 * resolved. With no query parameters this returns what it always did — every
 * active account — plus the extra fields.
 */
const listAccounts = asyncHandler(async (req, res) => {
  const { moneyOnly, subType, includeInactive } = req.query;
  const data = await AccountsService.list({
    moneyOnly: moneyOnly === 'true',
    subType,
    includeInactive: includeInactive === 'true',
  });
  sendSuccess(res, data, 'Chart of accounts retrieved successfully');
});

const listAccountGroups = asyncHandler(async (req, res) => {
  const data = Object.entries(ACCOUNT_GROUPS).map(([key, g]) => ({ key, ...g }));
  sendSuccess(res, data, 'Account groups retrieved successfully');
});

const createAccount = asyncHandler(async (req, res) => {
  if (req.body.openingBalance?.factoryId) await assertCanUseFactory(req, req.body.openingBalance.factoryId);
  sendSuccess(res, await AccountsService.create(req.body), 'Account created successfully', 201);
});

const updateAccount = asyncHandler(async (req, res) => {
  sendSuccess(res, await AccountsService.update(req.params.id, req.body), 'Account updated successfully');
});

const VOUCHER_MONEY = ['totalPaise'];

const listVouchers = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, voucherType, status, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await JournalVoucherService.list(Number(page), Number(limit), { voucherType, status, search, baseWhere });
  sendList(res, req, maskRateFields(data, req, VOUCHER_MONEY), 'Vouchers retrieved successfully');
});

const maskVoucher = (voucher, req) => {
  if (hasViewRates(req)) return voucher;
  return {
    ...voucher,
    totalPaise: null,
    lines: voucher.lines.map((l) => ({ ...l, debitPaise: null, creditPaise: null })),
  };
};

const getVoucher = asyncHandler(async (req, res) => {
  const voucher = await JournalVoucherService.get(req.params.id);
  await assertCanSeeRecord(req, voucher, 'Voucher not found');
  sendSuccess(res, maskVoucher(voucher, req), 'Voucher retrieved successfully');
});

const createVoucher = asyncHandler(async (req, res) => {
  await assertCanUseFactory(req, req.body.factoryId);
  sendSuccess(res, maskVoucher(await JournalVoucherService.create(req.body), req), 'Voucher posted successfully', 201);
});

const cancelVoucher = asyncHandler(async (req, res) => {
  const existing = await JournalVoucherService.get(req.params.id);
  await assertCanSeeRecord(req, existing, 'Voucher not found');
  sendSuccess(res, maskVoucher(await JournalVoucherService.cancel(req.params.id, req.body.reason), req), 'Voucher cancelled successfully');
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
  const { factoryId, from, to, accountKey, accountId } = req.query;
  await assertCanUseFactory(req, factoryId);
  const book = await LedgerService.getCashBook(factoryId, { from, to, accountKey, accountId });

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

/**
 * A financial statement is nothing but amounts, so masking them (BR-27) would
 * leave an empty page. Without VIEW_RATES the request is refused outright,
 * with the reason, instead.
 */
const assertCanSeeAmounts = (req) => {
  if (!hasViewRates(req)) throw new ForbiddenError('Financial statements show amounts — this needs the "View rates and amounts" permission');
};

const statementScope = async (req) => {
  if (req.query.factoryId) await assertCanUseFactory(req, req.query.factoryId);
  return { factoryId: req.query.factoryId, allowedFactoryIds: await getAllowedFactoryIds(req) };
};

const getProfitAndLoss = asyncHandler(async (req, res) => {
  assertCanSeeAmounts(req);
  const scope = await statementScope(req);
  const data = await FinancialStatementsService.profitAndLoss({ from: req.query.from, to: req.query.to, ...scope });
  sendSuccess(res, data, 'Profit and loss retrieved successfully');
});

const getBalanceSheet = asyncHandler(async (req, res) => {
  assertCanSeeAmounts(req);
  const scope = await statementScope(req);
  const data = await FinancialStatementsService.balanceSheet({ asOf: req.query.asOf, ...scope });
  sendSuccess(res, data, 'Balance sheet retrieved successfully');
});

module.exports = {
  getProfitAndLoss, getBalanceSheet,
  listAccounts, listAccountGroups, createAccount, updateAccount,
  getTrialBalance, getPartyLedger, getCashBook,
  listVouchers, getVoucher, createVoucher, cancelVoucher,
};
