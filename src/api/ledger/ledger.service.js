const { Op, fn, col } = require('sequelize');
const { Account } = require('./account.model');
const { JournalEntry } = require('./journalEntry.model');
const { JournalLine } = require('./journalLine.model');
const { Factory } = require('../factory/factory.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { SystemAccounts } = require('./systemAccounts');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { getUserId, getTenantId } = require('../../core/tenantContext');
const { addPaise } = require('../../utils/money');
const { logger } = require('../../utils/logger');

/**
 * The calendar day a DATEONLY column will actually store for `value`.
 *
 * The closed-year check used to read the first ten characters of the input,
 * while Sequelize stores DATEONLY values as moment(value).format('YYYY-MM-DD')
 * in the server's local zone. The two disagreed for any input carrying a time
 * or an offset: '2025-04-01T00:00:00+14:00' was checked as 1 April (open year)
 * and stored as 31 March (closed year). This mirrors the storage rule: a bare
 * YYYY-MM-DD is taken as written, anything else as a local calendar day.
 */
const storedDay = (value) => {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

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
    await this.assertPeriodOpen(factoryId, entryDate, transaction);

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

    // BR-21: factory cash balance may not go negative without override. Checked
    // per cash account — the system Cash-in-Hand and any cash account a user
    // has added (a site's petty-cash box is as physical as the main one).
    const cashAccount = await this.getOrCreateSystemAccount('CASH', transaction);
    const netCashCredit = new Map();
    for (const l of resolvedLines) {
      const isCash = l.accountId === cashAccount.id || l.account.subType === 'CASH';
      if (!isCash) continue;
      netCashCredit.set(l.accountId, (netCashCredit.get(l.accountId) || 0) + (l.creditPaise || 0) - (l.debitPaise || 0));
    }
    for (const [cashAccountId, cashCredit] of netCashCredit) {
      if (cashCredit <= 0) continue;
      const factory = await Factory.findByPk(factoryId, { transaction });
      const currentBalance = await this.getAccountBalance(cashAccountId, factoryId, transaction);
      if (currentBalance - cashCredit < 0 && !(factory && factory.allowNegativeCash)) {
        const label = cashAccountId === cashAccount.id ? 'cash' : `cash in ${resolvedLines.find((l) => l.accountId === cashAccountId).account.name}`;
        throw new ValidationError(`Insufficient ${label} at this factory: balance ${currentBalance} paise, requested ${cashCredit} paise`);
      }
      if (currentBalance - cashCredit < 0) {
        logger.warn({ message: 'Negative cash event', factoryId, accountId: cashAccountId, resultingBalance: currentBalance - cashCredit });
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

  /**
   * A CLOSED financial year is the audited, permanently locked one (the year
   * screen refuses to reopen or edit it), yet nothing stopped a document dated
   * inside it from posting — the lock covered the year record, not its books.
   * Every journal goes through postJournal, so this is the one place to hold
   * the line.
   *
   * SOFT_CLOSED stays postable on purpose: the period screen labels it
   * "Adjustments Only", and a rollover soft-closes the previous year
   * automatically, so late invoices and year-end adjustments still land there.
   *
   * Reversals post through here too. reverseJournal dates them today by
   * default, so cancelling an old document still works — the correction lands
   * in the open year. Only a reversal that deliberately back-dates into a
   * closed year (a cancelled depreciation run) is refused, which is the point.
   */
  static async assertPeriodOpen(factoryId, entryDate, transaction) {
    if (!entryDate) return;
    const day = storedDay(entryDate);
    if (!day) throw new ValidationError('The entry date is not a valid date');

    // Named explicitly: this also runs from jobs with no request context, where
    // the model's tenant hook adds nothing and the lookup would span tenants.
    const tenantId = getTenantId()
      || (await Factory.unscoped().findByPk(factoryId, { attributes: ['tenantId'], transaction }))?.tenantId;
    if (!tenantId) return;

    const closed = await FinancialYear.findOne({
      where: { tenantId, status: 'CLOSED', startDate: { [Op.lte]: day }, endDate: { [Op.gte]: day } },
      attributes: ['code'],
      transaction,
    });
    if (closed) {
      throw new ValidationError(`${day} is in a closed financial year (${closed.code}) — post it with a date in an open year`);
    }
  }

  static async getJournalEntry(id, transaction) {
    return JournalEntry.findByPk(id, {
      include: [{ model: JournalLine, as: 'lines', include: [{ model: Account, as: 'account' }] }],
      transaction,
    });
  }

  /**
   * BR-05/BR-33-style correction: a new balanced journal with debits/credits
   * swapped, referencing the original. Never edits the original.
   *
   * `entryDate` defaults to today, which is right for correcting a document
   * after the fact. A caller undoing something that should never have existed
   * on any date (a cancelled depreciation run) passes the original's date so
   * statements for past dates stop showing it.
   */
  static async reverseJournal(journalEntryId, reason, transaction, entryDate = null) {
    const original = await this.getJournalEntry(journalEntryId, transaction);
    if (!original) throw new NotFoundError('Journal entry not found');

    const reversed = await this.postJournal({
      factoryId: original.factoryId,
      entryDate: entryDate || new Date().toISOString().slice(0, 10),
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

  /**
   * BR-29 for party statements. A party (a customer, a vendor) is shared
   * across plants, but each posting belongs to the plant on its journal entry
   * — the same `je."factoryId"` the catalog ledger report scopes on
   * (reports/definitions/parties.js). Returns undefined for an unrestricted
   * caller so their queries are unchanged.
   */
  static factoryScopeWhere(allowedFactoryIds) {
    if (allowedFactoryIds === null || allowedFactoryIds === undefined) return undefined;
    return { factoryId: { [Op.in]: allowedFactoryIds.length ? allowedFactoryIds : ['00000000-0000-0000-0000-000000000000'] } };
  }

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
  static async getPartyLedger(partyId, { page = 1, limit = 50, allowedFactoryIds = null } = {}) {
    const offset = (page - 1) * limit;
    const payable = await this.isPayableParty(partyId);
    const signed = (debit, credit) => (payable ? credit - debit : debit - credit);
    const entryWhere = this.factoryScopeWhere(allowedFactoryIds);

    const { rows, count } = await JournalLine.findAndCountAll({
      where: { partyId },
      limit,
      offset,
      include: [
        { model: JournalEntry, as: 'journalEntry', where: entryWhere, required: true },
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
        include: [{ model: JournalEntry, as: 'journalEntry', attributes: [], where: entryWhere, required: true }],
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
  static async getPartyOutstanding(partyId, allowedFactoryIds = null) {
    const entryWhere = this.factoryScopeWhere(allowedFactoryIds);
    const result = await JournalLine.findOne({
      attributes: [
        [fn('COALESCE', fn('SUM', col('JournalLine.debitPaise')), 0), 'debit'],
        [fn('COALESCE', fn('SUM', col('JournalLine.creditPaise')), 0), 'credit'],
      ],
      where: { partyId },
      // Unrestricted callers keep the original join-free sum.
      include: entryWhere
        ? [{ model: JournalEntry, as: 'journalEntry', attributes: [], where: entryWhere, required: true }]
        : [],
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
  static async getCashBook(factoryId, { from, to, accountKey = 'CASH', accountId } = {}) {
    // A named account (one bank among several) wins over the system key.
    const account = accountId ? await Account.findByPk(accountId) : await this.getOrCreateSystemAccount(accountKey);
    if (!account) throw new NotFoundError('Account not found');

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
