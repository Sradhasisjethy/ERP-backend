const { sequelize } = require('../../config/database');
const { Cheque } = require('./cheque.model');
const { Receipt } = require('./receipt.model');
const { Payment } = require('./payment.model');
const { Party } = require('../parties/party.model');
const { LedgerService } = require('../ledger/ledger.service');
const { JournalEntry } = require('../ledger/journalEntry.model');
const { searchWhere } = require('../../utils/pagination');
const { NotFoundError, ValidationError } = require('../../core/AppError');

// A cheque may only move forward through its lifecycle. Encoding it as a map
// (rather than scattered if-statements) means an invalid transition is
// impossible to express, not merely unlikely.
const ALLOWED_TRANSITIONS = {
  ISSUED: ['PRESENTED', 'CANCELLED'],
  PRESENTED: ['CLEARED', 'BOUNCED'],
  CLEARED: [],
  BOUNCED: [],
  CANCELLED: [],
};

class ChequeService {
  static async list(page, limit, { factoryId, status, direction, partyId, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (status) where.status = status;
    if (direction) where.direction = direction;
    if (partyId) where.partyId = partyId;
    if (search) Object.assign(where, searchWhere(search, ['chequeNumber', 'bankName']));

    return Cheque.findAndCountAll({
      where, limit, offset,
      include: [{ model: Party, as: 'party' }],
      order: [['chequeDate', 'ASC']],
    });
  }

  static async get(id) {
    const cheque = await Cheque.findByPk(id, { include: [{ model: Party, as: 'party' }] });
    if (!cheque) throw new NotFoundError('Cheque not found');
    return cheque;
  }

  static async create(data) {
    if (!data.amountPaise || data.amountPaise <= 0) throw new ValidationError('Cheque amount must be positive');
    return Cheque.create(data);
  }

  static assertTransition(from, to) {
    if (!ALLOWED_TRANSITIONS[from]?.includes(to)) {
      throw new ValidationError(`A cheque cannot go from ${from} to ${to}`);
    }
  }

  static async present(id, { presentedAt } = {}) {
    const cheque = await this.get(id);
    this.assertTransition(cheque.status, 'PRESENTED');
    await cheque.update({ status: 'PRESENTED', presentedAt: presentedAt || new Date() });
    return this.get(id);
  }

  /**
   * Clearing needs no journal entry: the receipt/payment already posted to
   * BANK when it was recorded. Clearing only confirms that assumption held.
   */
  static async clear(id, { clearedAt } = {}) {
    const cheque = await this.get(id);
    this.assertTransition(cheque.status, 'CLEARED');
    await cheque.update({ status: 'CLEARED', clearedAt: clearedAt || new Date() });
    return this.get(id);
  }

  /**
   * FR-M18-7: a bounce reverses the original receipt/payment and recognises
   * bank charges.
   *
   * The reversal is a contra journal referencing the original (BR-05/AP-6) —
   * the original entry is never edited — and the parent document is marked
   * CANCELLED so the customer's dues reappear.
   */
  static async bounce(id, { reason, bankChargesPaise = 0, bouncedAt } = {}) {
    if (!reason) throw new ValidationError('A bounce reason is required');

    const cheque = await this.get(id);
    this.assertTransition(cheque.status, 'BOUNCED');

    return sequelize.transaction(async (transaction) => {
      const referenceType = cheque.direction === 'INBOUND' ? 'Receipt' : 'Payment';
      const referenceId = cheque.receiptId || cheque.paymentId;

      if (referenceId) {
        const entry = await JournalEntry.findOne({ where: { referenceType, referenceId }, transaction });
        if (entry) {
          await LedgerService.reverseJournal(entry.id, `Cheque ${cheque.chequeNumber} bounced: ${reason}`, transaction);
        }

        const Model = cheque.direction === 'INBOUND' ? Receipt : Payment;
        const parent = await Model.findByPk(referenceId, { transaction });
        if (parent && parent.status === 'POSTED') {
          await parent.update({ status: 'CANCELLED' }, { transaction });
        }
      }

      // Bank charges are a real cost of the bounce and are booked separately
      // from the reversal so they survive in the P&L.
      if (Number(bankChargesPaise) > 0) {
        await LedgerService.postJournal({
          factoryId: cheque.factoryId,
          entryDate: (bouncedAt || new Date()).toString().slice(0, 10),
          referenceType: 'Cheque',
          referenceId: cheque.id,
          narration: `Bank charges on bounced cheque ${cheque.chequeNumber}`,
          lines: [
            { accountKey: 'FACTORY_EXPENSE', debitPaise: Number(bankChargesPaise), creditPaise: 0 },
            { accountKey: 'BANK', debitPaise: 0, creditPaise: Number(bankChargesPaise) },
          ],
          transaction,
        });
      }

      await cheque.update(
        { status: 'BOUNCED', bounceReason: reason, bankChargesPaise: Number(bankChargesPaise) || 0, bouncedAt: bouncedAt || new Date() },
        { transaction }
      );

      return this.get(id);
    });
  }

  static async cancel(id, reason) {
    if (!reason) throw new ValidationError('A cancellation reason is required');
    const cheque = await this.get(id);
    this.assertTransition(cheque.status, 'CANCELLED');
    await cheque.update({ status: 'CANCELLED', bounceReason: reason });
    return this.get(id);
  }

  /** FR-M23-4: cheques due for presentation, for the accounts dashboard. */
  static async listDue(withinDays = 7) {
    const until = new Date();
    until.setDate(until.getDate() + withinDays);
    return Cheque.findAll({
      where: { status: ['ISSUED', 'PRESENTED'], chequeDate: { [require('sequelize').Op.lte]: until.toISOString().slice(0, 10) } },
      include: [{ model: Party, as: 'party' }],
      order: [['chequeDate', 'ASC']],
    });
  }
}

module.exports = { ChequeService };
