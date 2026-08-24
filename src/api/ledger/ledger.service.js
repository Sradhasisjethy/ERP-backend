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

  /**
   * @param {string}   [factoryId]        an explicit ?factoryId= filter
   * @param {string[]|null} [allowedFactoryIds] the caller's BR-29 restriction;
   *        null means unrestricted (platform/tenant admin)
   */
  static async getTrialBalance(factoryId, allowedFactoryIds = null) {
    const rows = await JournalLine.findAll({
      attributes: [
        'accountId',
        [fn('COALESCE', fn('SUM', col('JournalLine.debitPaise')), 0), 'totalDebit'],
        [fn('COALESCE', fn('SUM', col('JournalLine.creditPaise')), 0), 'totalCredit'],
      ],
      include: [
        {
          model: JournalEntry, as: 'journalEntry', attributes: [], required: true,
          where: factoryId
            ? { factoryId }
            : allowedFactoryIds
              ? { factoryId: { [Op.in]: allowedFactoryIds.length ? allowedFactoryIds : ['00000000-0000-0000-0000-000000000000'] } }
              : undefined,
        },
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
  /**
   * Party types whose control account is a liability, so what is owed shows as
   * a credit. Kept here as the single definition both the statement and the
   * outstanding figure read, and matching the RECEIVABLE / PAYABLE split the
   * reports module applies (reports/definitions/parties.js).
   */
  static PAYABLE_PARTY_TYPES = ['VENDOR', 'CONTRACTOR', 'LABOUR'];

  static async isPayableParty(partyId) {
    const { Party } = require('../parties/party.model');
    const party = await Party.findByPk(partyId, { attributes: ['partyType'] });
    return !!party && this.PAYABLE_PARTY_TYPES.includes(party.partyType);
  }

  /**
   * A party statement: every posting against them, oldest first, each line
   * carrying the balance as it stood after that posting.
   *
   * Three things this has to get right that the previous version did not:
   *
   *  - **Order.** It returned newest-first. A statement reads forward, and a
   *    running balance computed over a descending list is meaningless.
   *  - **The opening balance.** Page 2 of a statement has to start from where
   *    page 1 ended, so the balance before the page is summed separately
   *    rather than assumed to be zero.
   *  - **The sign.** See `getPartyOutstanding` — a payable is credit − debit.
   *    Running the same subtraction for both party types made every vendor
   *    statement read negative.
   */
  static async getPartyLedger(partyId, { page = 1, limit = 50 } = {}) {
    const offset = (page - 1) * limit;
    const payable = await this.isPayableParty(partyId);
    const signed = (debit, credit) => (payable ? credit - debit : debit - credit);

    const { rows, count } = await JournalLine.findAndCountAll({
      where: { partyId },
      limit,
      offset,
      include: [
        { model: JournalEntry, as: 'journalEntry' },
        { model: Account, as: 'account', attributes: ['code', 'name'] },
      ],
      order: [
        [{ model: JournalEntry, as: 'journalEntry' }, 'entryDate', 'ASC'],
        [{ model: JournalEntry, as: 'journalEntry' }, 'createdAt', 'ASC'],
        ['id', 'ASC'],
      ],
    });

    // Everything that happened before this page, so the running balance
    // continues rather than restarting.
    let openingBalancePaise = 0;
    if (offset > 0) {
      const earlier = await JournalLine.findAll({
        where: { partyId },
        limit: offset,
        offset: 0,
        include: [{ model: JournalEntry, as: 'journalEntry', attributes: [] }],
        order: [
          [{ model: JournalEntry, as: 'journalEntry' }, 'entryDate', 'ASC'],
          [{ model: JournalEntry, as: 'journalEntry' }, 'createdAt', 'ASC'],
          ['id', 'ASC'],
        ],
      });
      openingBalancePaise = earlier.reduce((sum, l) => sum + signed(Number(l.debitPaise), Number(l.creditPaise)), 0);
    }

    let running = openingBalancePaise;
    const withBalance = rows.map((line) => {
      running += signed(Number(line.debitPaise), Number(line.creditPaise));
      return { ...line.toJSON(), runningBalancePaise: running };
    });

    return { rows: withBalance, count, openingBalancePaise, closingBalancePaise: running };
  }

  /**
   * What this party owes, or is owed, signed the way a statement reads:
   * positive always means money is outstanding.
   *
   * The sign is not symmetric between party types. A customer posts against
   * ACCOUNTS_RECEIVABLE — the invoice debits, the receipt credits — so what
   * they owe is debit − credit. A vendor, contractor or labourer posts against
   * ACCOUNTS_PAYABLE, where the liability *credits* when they earn and debits
   * when they are paid, so the same expression returns the negation of what we
   * owe them.
   *
   * This endpoint applied `debit − credit` to everyone, so every vendor,
   * contractor and labour statement showed a negative outstanding balance
   * while the payables report — which has always had the split right — showed
   * the same figure positive. Two conventions for the same number in one
   * system is a reconciliation failure, and the statement convention is the
   * one that matches how the number is read.
   */
  static async getPartyOutstanding(partyId) {
    const result = await JournalLine.findOne({
      attributes: [
        [fn('COALESCE', fn('SUM', col('debitPaise')), 0), 'debit'],
        [fn('COALESCE', fn('SUM', col('creditPaise')), 0), 'credit'],
      ],
      where: { partyId },
      raw: true,
    });

    const debit = Number(result.debit);
    const credit = Number(result.credit);
    return (await this.isPayableParty(partyId)) ? credit - debit : debit - credit;
  }

  // BR-21/M29: factory-wise cash book / day book.
  /**
   * Cash (or bank) movement for a factory over a window, with the balance
   * carried forward.
   *
   * Two corrections over the previous version:
   *
   *  - **It read `entry.lines[0]`,** i.e. one cash line per journal. A receipt
   *    taken partly in two cash tenders posts two cash lines on the same
   *    journal, so only the first was counted and the day's cash was
   *    understated with no error anywhere. Every cash line on the entry is
   *    now summed.
   *  - **The running balance started at zero** however the window was
   *    filtered, so `opening + in − out = closing` was wrong by everything
   *    that happened before `from`. The opening balance is now the account's
   *    real position on the day the window starts.
   */
  static async getCashBook(factoryId, { from, to, accountKey = 'CASH' } = {}) {
    const account = await this.getOrCreateSystemAccount(accountKey);

    const openingBalancePaise = from
      ? await this.getAccountBalanceBefore(account.id, factoryId, from)
      : 0;

    const where = { entryDate: {} };
    if (from) where.entryDate[Op.gte] = from;
    if (to) where.entryDate[Op.lte] = to;
    if (!from && !to) delete where.entryDate;

    const entries = await JournalEntry.findAll({
      where: { factoryId, ...where },
      include: [{ model: JournalLine, as: 'lines', where: { accountId: account.id }, required: true }],
      order: [['entryDate', 'ASC'], ['createdAt', 'ASC']],
    });

    let runningBalance = openingBalancePaise;
    const rows = entries.map((entry) => {
      // Sum every line on this entry that touches the account — not just one.
      const debitPaise = entry.lines.reduce((sum, l) => sum + Number(l.debitPaise), 0);
      const creditPaise = entry.lines.reduce((sum, l) => sum + Number(l.creditPaise), 0);
      runningBalance += debitPaise - creditPaise;
      return {
        entryId: entry.id,
        date: entry.entryDate,
        narration: entry.narration,
        referenceType: entry.referenceType,
        referenceId: entry.referenceId,
        debitPaise,
        creditPaise,
        runningBalancePaise: runningBalance,
      };
    });

    return {
      accountCode: account.code,
      accountName: account.name,
      openingBalancePaise,
      closingBalancePaise: runningBalance,
      totalInPaise: rows.reduce((s, r) => s + r.debitPaise, 0),
      totalOutPaise: rows.reduce((s, r) => s + r.creditPaise, 0),
      rows,
    };
  }

  /** The account's balance at a factory immediately before `date`. */
  static async getAccountBalanceBefore(accountId, factoryId, date) {
    const result = await JournalLine.findOne({
      attributes: [
        [fn('COALESCE', fn('SUM', col('JournalLine.debitPaise')), 0), 'debit'],
        [fn('COALESCE', fn('SUM', col('JournalLine.creditPaise')), 0), 'credit'],
      ],
      where: { accountId },
      include: [{
        model: JournalEntry, as: 'journalEntry', attributes: [], required: true,
        where: { entryDate: { [Op.lt]: date }, ...(factoryId ? { factoryId } : {}) },
      }],
      raw: true,
    });
    return Number(result.debit) - Number(result.credit);
  }

  static async listAccounts() {
    return Account.findAll({ order: [['code', 'ASC']] });
  }
}

module.exports = { LedgerService };
