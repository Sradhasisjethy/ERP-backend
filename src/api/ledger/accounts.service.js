const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Account } = require('./account.model');
const { JournalLine } = require('./journalLine.model');
const { ACCOUNT_GROUPS, DEFAULT_GROUP_FOR_TYPE } = require('./accountGroups');
const { SystemAccounts, SYSTEM_ACCOUNT_CODES, SYSTEM_ACCOUNT_BY_CODE } = require('./systemAccounts');
const { NotFoundError, ValidationError, ConflictError } = require('../../core/AppError');

/**
 * Money accounts may sit in these groups. A bank account is normally a current
 * asset, but a cash-credit or overdraft account with a bank is a liability and
 * is paid from and into exactly like one. Cash is never a liability.
 */
const MONEY_ACCOUNT_GROUPS = {
  BANK: ['CURRENT_ASSET', 'CURRENT_LIABILITY', 'LONG_TERM_LIABILITY'],
  CASH: ['CURRENT_ASSET'],
};

/** What an account's group is, falling back to its system definition and then its type. */
const groupOf = (account) =>
  account.accountGroup
  || SYSTEM_ACCOUNT_BY_CODE.get(account.code)?.group
  || DEFAULT_GROUP_FOR_TYPE[account.type];

/** 'CASH', 'BANK' or null — whether money can be received into or paid from this account. */
const moneyKindOf = (account) =>
  account.subType
  || SYSTEM_ACCOUNT_BY_CODE.get(account.code)?.subType
  || null;

const isSystemAccount = (account) => SYSTEM_ACCOUNT_CODES.has(account.code);

/** The account as every screen should see it: group and kind resolved, system flag set. */
const accountView = (account) => {
  const json = typeof account.toJSON === 'function' ? account.toJSON() : { ...account };
  const group = groupOf(json);
  return {
    ...json,
    accountGroup: group,
    groupLabel: ACCOUNT_GROUPS[group]?.label || group,
    subType: moneyKindOf(json),
    isSystem: isSystemAccount(json),
  };
};

const trimOrNull = (value) => {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  return trimmed.length ? trimmed : null;
};

class AccountsService {
  static groupOf = groupOf;

  static moneyKindOf = moneyKindOf;

  static accountView = accountView;

  /**
   * The chart of accounts. `moneyOnly` narrows it to the accounts a receipt,
   * payment, expense or contra voucher can use; inactive accounts are left out
   * unless asked for, so a closed bank account stops appearing in pickers.
   */
  static async list({ moneyOnly = false, subType, includeInactive = false } = {}) {
    const where = {};
    if (!includeInactive) where.isActive = true;
    const rows = (await Account.findAll({ where, order: [['code', 'ASC']] })).map(accountView);
    return rows.filter((a) => {
      if (subType) return a.subType === subType;
      if (moneyOnly) return !!a.subType;
      return true;
    });
  }

  static async get(id, transaction) {
    const account = await Account.findByPk(id, { transaction });
    if (!account) throw new NotFoundError('Account not found');
    return account;
  }

  static validateGroupAndKind(accountGroup, subType) {
    if (!ACCOUNT_GROUPS[accountGroup]) {
      throw new ValidationError(`Unknown account group "${accountGroup}"`);
    }
    if (subType) {
      if (!MONEY_ACCOUNT_GROUPS[subType]) throw new ValidationError('A money account must be BANK or CASH');
      if (!MONEY_ACCOUNT_GROUPS[subType].includes(accountGroup)) {
        throw new ValidationError(
          `A ${subType.toLowerCase()} account cannot be in "${ACCOUNT_GROUPS[accountGroup].label}"`
        );
      }
    }
  }

  /**
   * `transaction` — reuse the caller's, so a bulk import can create every
   * account inside one transaction. A nested sequelize.transaction() here does
   * not become a savepoint; it takes a second pool connection, and the rows it
   * writes commit on their own whatever happens to the caller.
   */
  static async create(input, { transaction: outer = null } = {}) {
    const code = String(input.code || '').trim();
    const name = String(input.name || '').trim();
    if (!code) throw new ValidationError('An account code is required');
    if (!name) throw new ValidationError('An account name is required');
    if (SYSTEM_ACCOUNT_CODES.has(code)) {
      // The posting services find their accounts by code. Letting a user take
      // one would make every sale or receipt post into the user's account.
      throw new ValidationError(`Code ${code} is reserved for a system account — choose another`);
    }

    const accountGroup = input.accountGroup;
    const subType = input.subType || null;
    this.validateGroupAndKind(accountGroup, subType);
    const type = ACCOUNT_GROUPS[accountGroup].type;

    const run = async (transaction) => {
      const existing = await Account.findOne({ where: { code }, transaction });
      if (existing) throw new ConflictError(`An account with code ${code} already exists`);

      const account = await Account.create(
        {
          code, name, type, accountGroup, subType,
          isPartyControlAccount: false,
          isActive: true,
          description: trimOrNull(input.description),
          bankName: subType === 'BANK' ? trimOrNull(input.bankName) : null,
          accountNumber: subType === 'BANK' ? trimOrNull(input.accountNumber) : null,
          ifsc: subType === 'BANK' ? trimOrNull(input.ifsc)?.toUpperCase() || null : null,
          branch: subType === 'BANK' ? trimOrNull(input.branch) : null,
        },
        { transaction }
      );

      if (input.openingBalance && Number(input.openingBalance.amountPaise) > 0) {
        await this.postOpeningBalance(account, input.openingBalance, transaction);
      }

      return accountView(await this.get(account.id, transaction));
    };
    return outer ? run(outer) : sequelize.transaction(run);
  }

  /**
   * Books the balance an account already carried on the day it was added,
   * against Opening Balance Equity — the same contra every go-live figure uses
   * (M29), so the trial balance still balances.
   */
  static async postOpeningBalance(account, { factoryId, asOfDate, amountPaise, side }, transaction) {
    const { LedgerService } = require('./ledger.service');
    if (!factoryId) throw new ValidationError('An opening balance needs the factory it belongs to');
    if (!asOfDate) throw new ValidationError('An opening balance needs the date it was carried on');

    const amount = Number(amountPaise);
    const naturalSide = ['ASSET', 'EXPENSE'].includes(account.type) ? 'DEBIT' : 'CREDIT';
    const debit = (side || naturalSide) === 'DEBIT';

    await LedgerService.postJournal({
      factoryId,
      entryDate: asOfDate,
      referenceType: 'OpeningBalance',
      referenceId: account.id,
      narration: `Opening balance for ${account.name}`,
      lines: [
        { accountId: account.id, debitPaise: debit ? amount : 0, creditPaise: debit ? 0 : amount },
        { accountKey: 'OPENING_BALANCE_EQUITY', debitPaise: debit ? 0 : amount, creditPaise: debit ? amount : 0 },
      ],
      transaction,
    });
  }

  /**
   * Changes to an existing account.
   *
   * A system account keeps its code, group and kind — posting services and the
   * statements depend on them — but its bank details and description can be
   * filled in, which is what someone opening the one "Bank Account" wants.
   *
   * On a user account the group may change within the same type. Changing the
   * type of an account that already has postings would move history from one
   * side of the balance sheet to the other, so it is refused.
   */
  static async update(id, input, { transaction: outer = null } = {}) {
    const run = async (transaction) => {
      const account = await this.get(id, transaction);
      const system = isSystemAccount(account);
      const changes = {};

      if (!system) {
        if (input.name !== undefined) {
          const name = String(input.name).trim();
          if (!name) throw new ValidationError('An account name is required');
          changes.name = name;
        }

        const nextGroup = input.accountGroup ?? account.accountGroup ?? groupOf(account);
        const nextSubType = input.subType !== undefined ? (input.subType || null) : account.subType;
        if (input.accountGroup !== undefined || input.subType !== undefined) {
          this.validateGroupAndKind(nextGroup, nextSubType);
          const nextType = ACCOUNT_GROUPS[nextGroup].type;
          if (nextType !== account.type && (await this.hasPostings(account.id, transaction))) {
            throw new ValidationError(
              `${account.name} already has postings as ${account.type.toLowerCase()} — it cannot become ${nextType.toLowerCase()}`
            );
          }
          if (nextSubType !== account.subType && account.subType && (await this.hasPostings(account.id, transaction))) {
            throw new ValidationError(`${account.name} already has postings as a ${account.subType.toLowerCase()} account`);
          }
          Object.assign(changes, { accountGroup: nextGroup, type: nextType, subType: nextSubType });
        }
      } else if (input.name !== undefined || input.accountGroup !== undefined || input.subType !== undefined) {
        const touchesStructure =
          (input.name !== undefined && input.name !== account.name)
          || (input.accountGroup !== undefined && input.accountGroup !== groupOf(account))
          || (input.subType !== undefined && (input.subType || null) !== moneyKindOf(account));
        if (touchesStructure) {
          throw new ValidationError(`${account.name} is a system account — its name, group and kind are fixed`);
        }
      }

      if (input.description !== undefined) changes.description = trimOrNull(input.description);
      const kind = changes.subType !== undefined ? changes.subType : moneyKindOf(account);
      if (kind === 'BANK') {
        for (const field of ['bankName', 'accountNumber', 'branch']) {
          if (input[field] !== undefined) changes[field] = trimOrNull(input[field]);
        }
        if (input.ifsc !== undefined) changes.ifsc = trimOrNull(input.ifsc)?.toUpperCase() || null;
      }

      if (input.isActive !== undefined && input.isActive !== account.isActive) {
        if (system && input.isActive === false) {
          throw new ValidationError(`${account.name} is a system account and cannot be deactivated`);
        }
        if (input.isActive === false) {
          const { CashRegisterSession } = require('../cashRegister/cashRegisterSession.model');
          const openTill = await CashRegisterSession.findOne({ where: { accountId: account.id, status: 'OPEN' }, transaction });
          if (openTill) {
            throw new ValidationError(`${openTill.sessionNumber} is still open on ${account.name} — close the till before deactivating the account`);
          }
          const { LedgerService } = require('./ledger.service');
          const balance = await LedgerService.getAccountBalance(account.id, null, transaction);
          if (balance !== 0) {
            throw new ValidationError(
              `${account.name} still carries a balance — transfer it out before deactivating the account`
            );
          }
        }
        changes.isActive = input.isActive;
      }

      if (Object.keys(changes).length) await account.update(changes, { transaction });
      return accountView(await this.get(id, transaction));
    };
    return outer ? run(outer) : sequelize.transaction(run);
  }

  static async hasPostings(accountId, transaction) {
    return (await JournalLine.count({ where: { accountId }, transaction })) > 0;
  }

  /**
   * The account a receipt, payment or expense line should post to.
   *
   * Without an accountId this is exactly what it always was: the system
   * Cash-in-Hand for cash, the system Bank Account for everything else. With
   * one, it must be an active money account of the kind the mode implies — a
   * UPI receipt landing in the petty-cash box would put the cash book and the
   * bank statement out of step with no error anywhere.
   */
  static async resolveMoneyAccount({ accountId, mode }, transaction) {
    const kind = mode === 'CASH' ? 'CASH' : 'BANK';
    if (!accountId) return { accountKey: kind };

    const account = await Account.findByPk(accountId, { transaction });
    if (!account) throw new NotFoundError('Cash/bank account not found');
    if (!account.isActive) throw new ValidationError(`${account.name} is inactive`);
    const actual = moneyKindOf(account);
    if (actual !== kind) {
      throw new ValidationError(
        `${account.name} is not a ${kind.toLowerCase()} account — ${mode.toLowerCase()} money must go to a ${kind.toLowerCase()} account`
      );
    }
    return { accountId: account.id, account };
  }

  /** Every account id that is cash — the system Cash-in-Hand and any user cash account. */
  static async cashAccountIds(transaction) {
    const rows = await Account.findAll({
      where: { [Op.or]: [{ code: SystemAccounts.CASH.code }, { subType: 'CASH' }] },
      attributes: ['id'],
      transaction,
    });
    return rows.map((r) => r.id);
  }
}

module.exports = { AccountsService, accountView, groupOf, moneyKindOf, MONEY_ACCOUNT_GROUPS };
