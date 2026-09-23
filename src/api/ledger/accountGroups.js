/**
 * Where an account sits in the financial statements.
 *
 * `type` alone (ASSET, LIABILITY, ...) says which side of the books an account
 * is on, but not where it prints: a loan and a supplier balance are both
 * liabilities, and the P&L has to separate what it costs to make the product
 * (direct) from what it costs to run the company (indirect) before it can show
 * a gross profit. A group answers that, and every group belongs to exactly one
 * type, so choosing the group fixes the type — the two can never disagree.
 *
 * The keys are stored on `accounts.accountGroup` and must not be renamed.
 */
const ACCOUNT_GROUPS = Object.freeze({
  FIXED_ASSET: { type: 'ASSET', label: 'Fixed Assets', statement: 'BALANCE_SHEET', order: 10 },
  INVESTMENT: { type: 'ASSET', label: 'Investments', statement: 'BALANCE_SHEET', order: 20 },
  CURRENT_ASSET: { type: 'ASSET', label: 'Current Assets', statement: 'BALANCE_SHEET', order: 30 },
  LOANS_ADVANCES: { type: 'ASSET', label: 'Loans & Advances (Asset)', statement: 'BALANCE_SHEET', order: 40 },

  CAPITAL: { type: 'EQUITY', label: 'Capital Account', statement: 'BALANCE_SHEET', order: 10 },
  RESERVES: { type: 'EQUITY', label: 'Reserves & Surplus', statement: 'BALANCE_SHEET', order: 20 },

  LONG_TERM_LIABILITY: { type: 'LIABILITY', label: 'Loans (Liability)', statement: 'BALANCE_SHEET', order: 10 },
  CURRENT_LIABILITY: { type: 'LIABILITY', label: 'Current Liabilities', statement: 'BALANCE_SHEET', order: 20 },
  DUTIES_TAXES: { type: 'LIABILITY', label: 'Duties & Taxes', statement: 'BALANCE_SHEET', order: 30 },
  PROVISIONS: { type: 'LIABILITY', label: 'Provisions', statement: 'BALANCE_SHEET', order: 40 },

  DIRECT_INCOME: { type: 'INCOME', label: 'Sales & Direct Income', statement: 'PROFIT_AND_LOSS', order: 10 },
  INDIRECT_INCOME: { type: 'INCOME', label: 'Other Income', statement: 'PROFIT_AND_LOSS', order: 20 },
  DIRECT_EXPENSE: { type: 'EXPENSE', label: 'Purchases & Direct Expenses', statement: 'PROFIT_AND_LOSS', order: 10 },
  INDIRECT_EXPENSE: { type: 'EXPENSE', label: 'Indirect Expenses', statement: 'PROFIT_AND_LOSS', order: 20 },
});

/** The group an account with no explicit group falls into, by type. */
const DEFAULT_GROUP_FOR_TYPE = Object.freeze({
  ASSET: 'CURRENT_ASSET',
  LIABILITY: 'CURRENT_LIABILITY',
  EQUITY: 'CAPITAL',
  INCOME: 'INDIRECT_INCOME',
  EXPENSE: 'INDIRECT_EXPENSE',
});

module.exports = { ACCOUNT_GROUPS, DEFAULT_GROUP_FOR_TYPE };
