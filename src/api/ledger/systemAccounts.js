// Fixed chart-of-accounts codes every Phase 2 posting service refers to.
// Kept as codes (not hardcoded UUIDs) so accounts self-create per tenant on
// first use via LedgerService.getOrCreateSystemAccount.
const SystemAccounts = Object.freeze({
  CASH: { code: '1000', name: 'Cash-in-Hand', type: 'ASSET' },
  BANK: { code: '1010', name: 'Bank Account', type: 'ASSET' },
  ACCOUNTS_RECEIVABLE: { code: '1100', name: 'Accounts Receivable', type: 'ASSET', isPartyControlAccount: true },
  GST_INPUT: { code: '1200', name: 'GST Input Credit', type: 'ASSET' },
  ACCOUNTS_PAYABLE: { code: '2000', name: 'Accounts Payable', type: 'LIABILITY', isPartyControlAccount: true },
  GST_OUTPUT_CGST: { code: '2100', name: 'GST Output — CGST', type: 'LIABILITY' },
  GST_OUTPUT_SGST: { code: '2110', name: 'GST Output — SGST', type: 'LIABILITY' },
  GST_OUTPUT_IGST: { code: '2120', name: 'GST Output — IGST', type: 'LIABILITY' },
  SALES_REVENUE: { code: '4000', name: 'Sales Revenue', type: 'INCOME' },
  SALES_RETURN: { code: '4900', name: 'Sales Return', type: 'INCOME' },
  PURCHASE_EXPENSE: { code: '5000', name: 'Purchase Expense', type: 'EXPENSE' },
  PURCHASE_RETURN: { code: '5050', name: 'Purchase Return', type: 'EXPENSE' },
  JOB_WORK_EXPENSE: { code: '5100', name: 'Contractor Job-Work Expense', type: 'EXPENSE' },
  LABOUR_WAGE_EXPENSE: { code: '5200', name: 'Labour Wage Expense', type: 'EXPENSE' },
  FACTORY_EXPENSE: { code: '5900', name: 'Factory Expenses', type: 'EXPENSE' },
  ROUND_OFF: { code: '5950', name: 'Round Off', type: 'EXPENSE' },
  // M29: the contra account for opening balances. Every opening figure posts
  // against this at go-live so the books balance from day one instead of
  // arriving as a set of unexplained one-sided entries (AP-3).
  OPENING_BALANCE_EQUITY: { code: '3000', name: 'Opening Balance Equity', type: 'EQUITY' },
});

module.exports = { SystemAccounts };
