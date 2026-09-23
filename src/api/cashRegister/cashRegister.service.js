const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { CashRegisterSession } = require('./cashRegisterSession.model');
const { Account } = require('../ledger/account.model');
const { JournalEntry } = require('../ledger/journalEntry.model');
const { JournalLine } = require('../ledger/journalLine.model');
const { LedgerService } = require('../ledger/ledger.service');
const { moneyKindOf } = require('../ledger/accounts.service');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { NotFoundError, ValidationError, ConflictError } = require('../../core/AppError');
const { getUserId } = require('../../core/tenantContext');
const { isoDateInZone } = require('../../utils/dateDisplay');
const { env } = require('../../config/env');

/**
 * Cash register sessions.
 *
 * A session moves no money. Cash sales, petty payouts and top-ups from the
 * bank are posted by the modules that own them — counter sales, expenses,
 * contra vouchers — and the session simply reads the cash account either side
 * of the shift:
 *
 *   expected  = what the cash account says is at this factory right now
 *   counted   = the notes and coins actually in the drawer
 *   variance  = counted − expected
 *
 * That is the whole point of counting a till: a positive variance is cash
 * nobody recorded taking, a negative one is cash that has gone missing. The
 * books are only corrected when someone accepts the difference at close, and
 * then it posts to Cash Short / Excess so the write-off is visible in the P&L
 * rather than buried in the cash balance.
 */

const DENOMINATIONS = [2000, 500, 200, 100, 50, 20, 10, 5, 2, 1];

/** Rupee value of a { "500": 10, ... } count, in paise. */
const countDenominations = (denominations) => {
  if (!denominations) return 0;
  let paise = 0;
  for (const [value, count] of Object.entries(denominations)) {
    const note = Number(value);
    const many = Number(count);
    if (!Number.isFinite(note) || note <= 0) throw new ValidationError(`"${value}" is not a note or coin value`);
    if (!Number.isInteger(many) || many < 0) throw new ValidationError(`The count for ₹${value} must be a whole number, not "${count}"`);
    paise += Math.round(note * 100) * many;
  }
  return paise;
};

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

const view = (session) => {
  const json = session.toJSON();
  const num = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    ...json,
    openingCountedPaise: num(json.openingCountedPaise),
    openingExpectedPaise: num(json.openingExpectedPaise),
    openingVariancePaise: num(json.openingVariancePaise),
    closingCountedPaise: num(json.closingCountedPaise),
    closingExpectedPaise: num(json.closingExpectedPaise),
    closingVariancePaise: num(json.closingVariancePaise),
  };
};

class CashRegisterService {
  static get DENOMINATIONS() {
    return DENOMINATIONS;
  }

  /** The till's account: the one named, or the system Cash-in-Hand. */
  static async resolveTill(accountId, transaction) {
    if (!accountId) return LedgerService.getOrCreateSystemAccount('CASH', transaction);
    const account = await Account.findByPk(accountId, { transaction });
    if (!account) throw new NotFoundError('Cash account not found');
    if (moneyKindOf(account) !== 'CASH') throw new ValidationError(`${account.name} is not a cash account`);
    if (!account.isActive) throw new ValidationError(`${account.name} is inactive`);
    return account;
  }

  static async openSession({ factoryId, accountId, denominations, note }) {
    return sequelize.transaction(async (transaction) => {
      const till = await this.resolveTill(accountId, transaction);

      const already = await CashRegisterSession.findOne({
        where: { factoryId, accountId: accountId || null, status: 'OPEN' },
        transaction,
      });
      if (already) throw new ConflictError(`${already.sessionNumber} is still open at this till — close it before opening another`);

      const expected = await LedgerService.getAccountBalance(till.id, factoryId, transaction);
      const counted = countDenominations(denominations);

      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('CASH_SESSION', { factoryId, financialYearId, prefix: 'CS', transaction });

      const session = await CashRegisterSession.create(
        {
          factoryId, accountId: accountId || null, sessionNumber: documentNumber, status: 'OPEN',
          openedAt: new Date(), openedBy: getUserId() || null,
          openingDenominations: denominations || null,
          openingCountedPaise: counted,
          openingExpectedPaise: expected,
          openingVariancePaise: counted - expected,
          openingNote: note || null,
        },
        { transaction }
      );
      return view(session);
    });
  }

  static async get(id, transaction) {
    const session = await CashRegisterSession.findByPk(id, { transaction });
    if (!session) throw new NotFoundError('Cash register session not found');
    return session;
  }

  static async list(page, limit, { status, baseWhere = {} } = {}) {
    const where = { ...baseWhere };
    if (status) where.status = status;
    const { rows, count } = await CashRegisterSession.findAndCountAll({
      where, limit, offset: (page - 1) * limit, order: [['openedAt', 'DESC']],
    });
    return { rows: rows.map(view), count };
  }

  static async current(factoryId, accountId = null) {
    const session = await CashRegisterSession.findOne({
      where: { factoryId, accountId: accountId || null, status: 'OPEN' },
      order: [['openedAt', 'DESC']],
    });
    return session ? this.detail(session.id) : null;
  }

  /**
   * The session with everything that touched the till while it was open, read
   * from the journal rather than kept in a second place of its own.
   */
  static async detail(id) {
    const session = await this.get(id);
    const till = await this.resolveTill(session.accountId);
    const until = session.closedAt || new Date();

    const lines = await JournalLine.findAll({
      where: { accountId: till.id },
      include: [{
        model: JournalEntry, as: 'journalEntry', required: true,
        where: { factoryId: session.factoryId, createdAt: { [Op.gte]: session.openedAt, [Op.lte]: until } },
      }],
      order: [[{ model: JournalEntry, as: 'journalEntry' }, 'createdAt', 'ASC']],
    });

    const movements = lines.map((l) => ({
      id: l.id,
      at: l.journalEntry.createdAt,
      referenceType: l.journalEntry.referenceType,
      narration: l.journalEntry.narration,
      inPaise: Number(l.debitPaise),
      outPaise: Number(l.creditPaise),
    }));

    const totalInPaise = movements.reduce((s, m) => s + m.inPaise, 0);
    const totalOutPaise = movements.reduce((s, m) => s + m.outPaise, 0);
    const expectedNowPaise = await LedgerService.getAccountBalance(till.id, session.factoryId);

    return {
      ...view(session),
      account: { id: till.id, code: till.code, name: till.name },
      movements,
      totalInPaise,
      totalOutPaise,
      expectedNowPaise,
      // What the drawer should hold right now, for the close screen to compare against.
      countedSoFarPaise: session.status === 'OPEN' ? null : Number(session.closingCountedPaise),
    };
  }

  /**
   * Closes the shift on a count.
   *
   * With `postAdjustment` the difference is written to the books so the cash
   * account matches the drawer; without it the session records the difference
   * and the books are left alone for someone to investigate.
   */
  static async closeSession(id, { denominations, note, postAdjustment = false }) {
    return sequelize.transaction(async (transaction) => {
      const session = await CashRegisterSession.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!session) throw new NotFoundError('Cash register session not found');
      if (session.status !== 'OPEN') throw new ValidationError(`${session.sessionNumber} is already closed`);

      const till = await this.resolveTill(session.accountId, transaction);
      const expected = await LedgerService.getAccountBalance(till.id, session.factoryId, transaction);
      const counted = countDenominations(denominations);
      const variance = counted - expected;

      if (variance !== 0 && postAdjustment) {
        const short = variance < 0;
        await LedgerService.postJournal({
          factoryId: session.factoryId,
          entryDate: isoDateInZone(new Date(), env.APP_TIMEZONE),
          referenceType: 'CashRegisterSession',
          referenceId: session.id,
          narration: `${session.sessionNumber} closing count: cash ${short ? 'short' : 'over'} by ${Math.abs(variance)} paise`,
          lines: short
            ? [
                { accountKey: 'CASH_SHORT_EXCESS', debitPaise: -variance, creditPaise: 0 },
                { accountId: till.id, debitPaise: 0, creditPaise: -variance },
              ]
            : [
                { accountId: till.id, debitPaise: variance, creditPaise: 0 },
                { accountKey: 'CASH_SHORT_EXCESS', debitPaise: 0, creditPaise: variance },
              ],
          transaction,
        });
      }

      await session.update(
        {
          status: 'CLOSED',
          closedAt: new Date(),
          closedBy: getUserId() || null,
          closingDenominations: denominations || null,
          closingCountedPaise: counted,
          closingExpectedPaise: expected,
          closingVariancePaise: variance,
          varianceAdjusted: variance !== 0 && postAdjustment,
          closingNote: note || null,
        },
        { transaction }
      );
      return view(session);
    });
  }
}

module.exports = { CashRegisterService, countDenominations, DENOMINATIONS };
