// Fixed chart-of-accounts codes every Phase 2 posting service refers to.
// Kept as codes (not hardcoded UUIDs) so accounts self-create per tenant on
// first use via LedgerService.getOrCreateSystemAccount.
//
// `group` places the account in the financial statements (see accountGroups.js).
// It lives here rather than only on the row because system accounts created
// before the column existed have no stored group, and they must still land in
// the right section of the P&L and balance sheet.
const SystemAccounts = Object.freeze({
  CASH: { code: '1000', name: 'Cash-in-Hand', type: 'ASSET', group: 'CURRENT_ASSET', subType: 'CASH' },
  BANK: { code: '1010', name: 'Bank Account', type: 'ASSET', group: 'CURRENT_ASSET', subType: 'BANK' },
  ACCOUNTS_RECEIVABLE: { code: '1100', name: 'Accounts Receivable', type: 'ASSET', group: 'CURRENT_ASSET', isPartyControlAccount: true },
  GST_INPUT: { code: '1200', name: 'GST Input Credit', type: 'ASSET', group: 'CURRENT_ASSET' },
  FIXED_ASSETS: { code: '1500', name: 'Fixed Assets', type: 'ASSET', group: 'FIXED_ASSET' },
  // A contra-asset: it carries a credit balance and is shown as a deduction
  // from Fixed Assets, so the cost of an asset stays visible after it has been
  // depreciated.
  ACCUMULATED_DEPRECIATION: { code: '1590', name: 'Accumulated Depreciation', type: 'ASSET', group: 'FIXED_ASSET' },
  ACCOUNTS_PAYABLE: { code: '2000', name: 'Accounts Payable', type: 'LIABILITY', group: 'CURRENT_LIABILITY', isPartyControlAccount: true },
  GST_OUTPUT_CGST: { code: '2100', name: 'GST Output — CGST', type: 'LIABILITY', group: 'DUTIES_TAXES' },
  GST_OUTPUT_SGST: { code: '2110', name: 'GST Output — SGST', type: 'LIABILITY', group: 'DUTIES_TAXES' },
  GST_OUTPUT_IGST: { code: '2120', name: 'GST Output — IGST', type: 'LIABILITY', group: 'DUTIES_TAXES' },
  SALES_REVENUE: { code: '4000', name: 'Sales Revenue', type: 'INCOME', group: 'DIRECT_INCOME' },
  SALES_RETURN: { code: '4900', name: 'Sales Return', type: 'INCOME', group: 'DIRECT_INCOME' },
  // Profit or loss on selling a fixed asset — not trading income, so it sits
  // below gross profit.
  ASSET_DISPOSAL_GAIN_LOSS: { code: '4950', name: 'Profit/Loss on Sale of Assets', type: 'INCOME', group: 'INDIRECT_INCOME' },
  PURCHASE_EXPENSE: { code: '5000', name: 'Purchase Expense', type: 'EXPENSE', group: 'DIRECT_EXPENSE' },
  PURCHASE_RETURN: { code: '5050', name: 'Purchase Return', type: 'EXPENSE', group: 'DIRECT_EXPENSE' },
  JOB_WORK_EXPENSE: { code: '5100', name: 'Contractor Job-Work Expense', type: 'EXPENSE', group: 'DIRECT_EXPENSE' },
  LABOUR_WAGE_EXPENSE: { code: '5200', name: 'Labour Wage Expense', type: 'EXPENSE', group: 'DIRECT_EXPENSE' },
  DEPRECIATION_EXPENSE: { code: '5800', name: 'Depreciation', type: 'EXPENSE', group: 'INDIRECT_EXPENSE' },
  FACTORY_EXPENSE: { code: '5900', name: 'Factory Expenses', type: 'EXPENSE', group: 'INDIRECT_EXPENSE' },
  ROUND_OFF: { code: '5950', name: 'Round Off', type: 'EXPENSE', group: 'INDIRECT_EXPENSE' },
  // Where a counted till differs from the books. A shortfall is an expense; an
  // excess debits cash and credits this account, leaving it with a credit
  // balance, which is exactly how it should read.
  CASH_SHORT_EXCESS: { code: '5960', name: 'Cash Short / Excess', type: 'EXPENSE', group: 'INDIRECT_EXPENSE' },
  // M29: the contra account for opening balances. Every opening figure posts
  // against this at go-live so the books balance from day one instead of
  // arriving as a set of unexplained one-sided entries (AP-3).
  OPENING_BALANCE_EQUITY: { code: '3000', name: 'Opening Balance Equity', type: 'EQUITY', group: 'CAPITAL' },
});

/** Codes a user-created account may not take, because a posting service owns them. */
const SYSTEM_ACCOUNT_CODES = new Set(Object.values(SystemAccounts).map((a) => a.code));

const SYSTEM_ACCOUNT_BY_CODE = new Map(Object.values(SystemAccounts).map((a) => [a.code, a]));

module.exports = { SystemAccounts, SYSTEM_ACCOUNT_CODES, SYSTEM_ACCOUNT_BY_CODE };
