const { Op, fn, col, literal } = require('sequelize');
const { sequelize } = require('../../config/database');
const { Account } = require('./account.model');
const { JournalEntry } = require('./journalEntry.model');
const { JournalLine } = require('./journalLine.model');
const { Factory } = require('../factory/factory.model');
const { SystemAccounts } = require('./systemAccounts');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { getUserId } = require('../../core/tenantContext');
const { addPaise } = require('../../utils/money');
const { logger } = require('../../utils/logger');

class LedgerService {
  static async getOrCreateSystemAccount(key, transaction) {
    const def = SystemAccounts[key];
    if (!def) throw new Error(`Unknown system account key: ${key}`);

    const [account] = await Account.findOrCreate({
      where: { code: def.code },
      defaults: { code: def.code, name: def.name, type: def.type, isPartyControlAccount: !!def.isPartyControlAccount },
      transaction,
    });
    return account;
  }

  /**
   * Posts a balanced journal (BR-18). `lines` is [{ accountKey | accountId,
   * partyId, debitPaise, creditPaise }] — pass accountKey (a SystemAccounts
   * key) to resolve/auto-create the system account, or accountId directly.
   * Rejects (throws, so nothing commits) if debits don't equal credits, or if
   * a CASH-account credit would take a factory's cash balance negative
   * without BR-21's override.
   */
  static async postJournal({ factoryId, entryDate, referenceType, referenceId, narration, lines, transaction }) {
    if (!lines || lines.length < 2) throw new ValidationError('A journal entry requires at least two lines');

    const resolvedLines = [];
    for (const line of lines) {
      const account = line.accountId
        ? await Account.findByPk(line.accountId, { transaction })
        : await this.getOrCreateSystemAccount(line.accountKey, transaction);
      if (!account) throw new NotFoundError('Account not found');
      if (account.isPartyControlAccount && !line.partyId) {
        throw new ValidationError(`${account.name} requires a partyId on every line`);
      }
      resolvedLines.push({ ...line, accountId: account.id, account });
    }

    const totalDebitPaise = addPaise(...resolvedLines.map((l) => l.debitPaise || 0));
    const totalCreditPaise = addPaise(...resolvedLines.map((l) => l.creditPaise || 0));
    if (totalDebitPaise !== totalCreditPaise) {
      throw new ValidationError(`Journal is not balanced: debits ${totalDebitPaise} paise, credits ${totalCreditPaise} paise`);
    }

    // BR-21: factory cash balance may not go negative without override.
    const cashAccount = await this.getOrCreateSystemAccount('CASH', transaction);
    const cashCredit = resolvedLines
      .filter((l) => l.accountId === cashAccount.id)
      .reduce((sum, l) => sum + (l.creditPaise || 0) - (l.debitPaise || 0), 0);
    if (cashCredit > 0) {
      const factory = await Factory.findByPk(factoryId, { transaction });
      const currentBalance = await this.getAccountBalance(cashAccount.id, factoryId, transaction);
      if (currentBalance - cashCredit < 0 && !(factory && factory.allowNegativeCash)) {
        throw new ValidationError(`Insufficient cash at this factory: balance ${currentBalance} paise, requested ${cashCredit} paise`);
      }
      if (currentBalance - cashCredit < 0) {
        logger.warn({ message: 'Negative cash event', factoryId, resultingBalance: currentBalance - cashCredit });
      }
    }

    const entry = await JournalEntry.create(
      { factoryId, entryDate, referenceType, referenceId, narration, totalDebitPaise, totalCreditPaise, createdBy: getUserId() || null },
      { transaction }
    );

    await JournalLine.bulkCreate(
      resolvedLines.map((l) => ({
        journalEntryId: entry.id,
        accountId: l.accountId,
        partyId: l.partyId || null,
        debitPaise: l.debitPaise || 0,
        creditPaise: l.creditPaise || 0,
      })),
      { transaction, individualHooks: true, validate: true }
    );

    return this.getJournalEntry(entry.id, transaction);
  }

  static async getJournalEntry(id, transaction) {
    return JournalEntry.findByPk(id, {
      include: [{ model: JournalLine, as: 'lines', include: [{ model: Account, as: 'account' }] }],
      transaction,
    });
  }

  /** BR-05/BR-33-style correction: a new balanced journal with debits/credits swapped, referencing the original. Never edits the original. */
  static async reverseJournal(journalEntryId, reason, transaction) {
    const original = await this.getJournalEntry(journalEntryId, transaction);
    if (!original) throw new NotFoundError('Journal entry not found');

    const reversed = await this.postJournal({
      factoryId: original.factoryId,
      entryDate: new Date().toISOString().slice(0, 10),
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      narration: reason,
      lines: original.lines.map((l) => ({ accountId: l.accountId, partyId: l.partyId, debitPaise: l.creditPaise, creditPaise: l.debitPaise })),
      transaction,
    });

    await JournalEntry.update({ reversalOfEntryId: original.id }, { where: { id: reversed.id }, transaction });
    return reversed;
  }

  static async getAccountBalance(accountId, factoryId, transaction) {
    const result = await JournalLine.findOne({
      attributes: [
        [fn('COALESCE', fn('SUM', col('debitPaise')), 0), 'debit'],
        [fn('COALESCE', fn('SUM', col('creditPaise')), 0), 'credit'],
      ],
      where: { accountId },
      include: [{ model: JournalEntry, as: 'journalEntry', attributes: [], where: factoryId ? { factoryId } : undefined, required: true }],
      transaction,
      raw: true,
    });
    return Number(result.debit) - Number(result.credit);
  }

  static async getTrialBalance(factoryId) {
    const rows = await JournalLine.findAll({
      attributes: [
        'accountId',
        [fn('COALESCE', fn('SUM', col('JournalLine.debitPaise')), 0), 'totalDebit'],
        [fn('COALESCE', fn('SUM', col('JournalLine.creditPaise')), 0), 'totalCredit'],
      ],
      include: [
        { model: JournalEntry, as: 'journalEntry', attributes: [], where: factoryId ? { factoryId } : undefined, required: true },
        { model: Account, as: 'account', attributes: ['code', 'name', 'type'] },
      ],
      group: ['accountId', 'account.id', 'account.code', 'account.name', 'account.type'],
      order: [[{ model: Account, as: 'account' }, 'code', 'ASC']],
    });

    return rows.map((r) => ({
      accountId: r.accountId,
      code: r.account.code,
      name: r.account.name,
      type: r.account.type,
      totalDebitPaise: Number(r.get('totalDebit')),
      totalCreditPaise: Number(r.get('totalCredit')),
      balancePaise: Number(r.get('totalDebit')) - Number(r.get('totalCredit')),
    }));
  }

  // Party statement + running balance (AR for customers, AP for vendors/contractors/labour).
  static async getPartyLedger(partyId, { page = 1, limit = 50 } = {}) {
    const offset = (page - 1) * limit;
    const { rows, count } = await JournalLine.findAndCountAll({
      where: { partyId },
      limit,
      offset,
      include: [
        { model: JournalEntry, as: 'journalEntry' },
        { model: Account, as: 'account', attributes: ['code', 'name'] },
      ],
      order: [[{ model: JournalEntry, as: 'journalEntry' }, 'entryDate', 'DESC'], [{ model: JournalEntry, as: 'journalEntry' }, 'createdAt', 'DESC']],
    });
    return { rows, count };
  }

  static async getPartyOutstanding(partyId) {
    const result = await JournalLine.findOne({
      attributes: [
        [fn('COALESCE', fn('SUM', col('debitPaise')), 0), 'debit'],
        [fn('COALESCE', fn('SUM', col('creditPaise')), 0), 'credit'],
      ],
      where: { partyId },
      raw: true,
    });
    // Positive = they owe us (AR) or we owe them less (AP net debit); the
    // sign convention is the same either way since each party only ever
    // posts against their own single control account (AR *or* AP per type).
    return Number(result.debit) - Number(result.credit);
  }

  // BR-21/M29: factory-wise cash book / day book.
  static async getCashBook(factoryId, { from, to, accountKey = 'CASH' } = {}) {
    const account = await this.getOrCreateSystemAccount(accountKey);
    const where = { entryDate: {} };
    if (from) where.entryDate[Op.gte] = from;
    if (to) where.entryDate[Op.lte] = to;
    if (!from && !to) delete where.entryDate;

    const entries = await JournalEntry.findAll({
      where: { factoryId, ...where },
      include: [{ model: JournalLine, as: 'lines', where: { accountId: account.id }, required: true }],
      order: [['entryDate', 'ASC'], ['createdAt', 'ASC']],
    });

    let runningBalance = 0;
    return entries.map((entry) => {
      const line = entry.lines[0];
      runningBalance += Number(line.debitPaise) - Number(line.creditPaise);
      return {
        entryId: entry.id,
        date: entry.entryDate,
        narration: entry.narration,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        debitPaise: Number(line.debitPaise),
        creditPaise: Number(line.creditPaise),
        runningBalancePaise: runningBalance,
      };
    });
  }

  static async listAccounts() {
    return Account.findAll({ order: [['code', 'ASC']] });
  }
}

module.exports = { LedgerService };
