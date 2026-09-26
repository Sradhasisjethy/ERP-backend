const { Op } = require('sequelize');
const { Account } = require('../../ledger/account.model');
const { AccountsService } = require('../../ledger/accounts.service');
const { ACCOUNT_GROUPS } = require('../../ledger/accountGroups');
const { SYSTEM_ACCOUNT_CODES } = require('../../ledger/systemAccounts');

/**
 * The chart of accounts.
 *
 * Two rules the importer does not restate, because AccountsService already
 * holds them and a second copy would be the one that goes stale:
 *
 *  - a system account code is reserved (the posting services find their
 *    accounts by code, so handing one to a user account would send every sale
 *    into it), and
 *  - an account with postings cannot change the side of the books it sits on.
 *
 * What the importer does add is a refusal to *touch* a system account at all.
 * An export of the chart contains them; re-importing that file unchanged must
 * be a no-op rather than twenty pointless update attempts.
 */

const groupLabels = Object.fromEntries(Object.entries(ACCOUNT_GROUPS).map(([key, group]) => [group.label, key]));
const kinds = { 'Not a money account': '', Bank: 'BANK', Cash: 'CASH' };

const accounts = {
  key: 'accounts',
  label: 'Chart of Accounts',
  fileBase: 'Chart_Of_Accounts',
  resource: 'ACCOUNT',
  businessKey: 'code',
  businessKeyHeader: 'Account Code',
  notes: [
    { key: 'System accounts', value: 'Sales, GST, Receivables and the rest are built in. They appear in an export, are skipped on import, and their codes cannot be reused.' },
    { key: 'Opening balances', value: 'Not set by this import. Add an account here, then post its opening balance from the Chart of Accounts screen so it books against Opening Balance Equity.' },
    { key: 'Bank details', value: 'Bank Name, Account Number, IFSC and Branch are stored only when Kind is Bank.' },
  ],
  columns: [
    { header: 'ID', field: 'id', type: 'text', readOnly: true, note: 'Filled in by Export. Leave blank for a new record.' },
    { header: 'Account Code', field: 'code', type: 'code', required: true, maxLength: 20, example: '1210', note: 'unique; used to match an existing account' },
    { header: 'Account Name', field: 'name', type: 'text', required: true, maxLength: 120, example: 'HDFC Current Account' },
    {
      header: 'Account Group', field: 'accountGroup', type: 'enum', required: true,
      values: Object.keys(groupLabels), enumMap: groupLabels, example: 'Current Assets',
      note: 'the group fixes the account type, so the two can never disagree',
    },
    {
      header: 'Kind', field: 'subType', type: 'enum', values: Object.keys(kinds), enumMap: kinds,
      example: 'Bank', note: 'Bank or Cash makes the account usable for receipts, payments and contra vouchers',
      exportValue: (record) => record.subType || 'Not a money account',
    },
    { header: 'Description', field: 'description', type: 'text', maxLength: 255, example: '' },
    { header: 'Bank Name', field: 'bankName', type: 'text', maxLength: 100, example: 'HDFC Bank' },
    { header: 'Bank Account Number', field: 'accountNumber', type: 'text', maxLength: 50, example: '50100234567890' },
    { header: 'IFSC', field: 'ifsc', type: 'code', maxLength: 11, example: 'HDFC0000123' },
    { header: 'Branch', field: 'branch', type: 'text', maxLength: 100, example: 'Saheed Nagar' },
    {
      header: 'Status', field: 'isActive', type: 'enum', values: ['Active', 'Inactive'],
      enumMap: { Active: true, Inactive: false }, example: 'Active',
      note: 'an account carrying a balance or an open till cannot be deactivated',
    },
  ],
  examples: [
    { code: '1210', name: 'HDFC Current Account', accountGroup: 'Current Assets', subType: 'Bank', description: '', bankName: 'HDFC Bank', accountNumber: '50100234567890', ifsc: 'HDFC0000123', branch: 'Saheed Nagar', isActive: 'Active' },
    { code: '5310', name: 'Diesel & Fuel', accountGroup: 'Indirect Expenses', subType: 'Not a money account', description: 'Lorry fuel', bankName: '', accountNumber: '', ifsc: '', branch: '', isActive: 'Active' },
  ],
  load: async ({ query = {} }) =>
    Account.findAll({
      where: {
        ...(query.includeInactive === 'true' || query.includeInactive === true ? {} : { isActive: true }),
        ...(query.search
          ? { [Op.or]: ['code', 'name'].map((column) => ({ [column]: { [Op.iLike]: `%${query.search}%` } })) }
          : {}),
      },
      order: [['code', 'ASC']],
    }),
  /**
   * A system account in the file is left exactly as it is. Re-importing an
   * unchanged export should do nothing, not fail twenty times over on rows the
   * service would refuse anyway.
   */
  skipRow: (values, record) => {
    const code = String(values.code || record?.code || '').trim();
    if (SYSTEM_ACCOUNT_CODES.has(code)) {
      return `${code} is a built-in system account — left unchanged`;
    }
    return null;
  },
  create: (values, context, options) => AccountsService.create(values, options),
  update: (record, values, context, options) => AccountsService.update(record.id, values, options),
};

module.exports = { accounts };
