const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { searchWhere } = require('../../utils/pagination');
const { JournalVoucher } = require('./journalVoucher.model');
const { JournalEntry } = require('./journalEntry.model');
const { Account } = require('./account.model');
const { LedgerService } = require('./ledger.service');
const { moneyKindOf, accountView } = require('./accounts.service');
const { FinancialYear } = require('../factory/financialYear.model');
const { Factory } = require('../factory/factory.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { getUserId } = require('../../core/tenantContext');
const { addPaise } = require('../../utils/money');
const { assertNotFuture } = require('../../utils/businessDate');

const REFERENCE_TYPE = 'JournalVoucher';

const SERIES = {
  JOURNAL: { documentType: 'JOURNAL_VOUCHER', prefix: 'JV' },
  CONTRA: { documentType: 'CONTRA_VOUCHER', prefix: 'CV' },
};

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

class JournalVoucherService {
  static async list(page, limit, { voucherType, status, search, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (voucherType) where.voucherType = voucherType;
    if (status) where.status = status;
    if (search) Object.assign(where, searchWhere(search, ['voucherNumber', 'narration']));
    const { rows, count } = await JournalVoucher.findAndCountAll({
      where, limit, offset,
      order: [['voucherDate', 'DESC'], ['createdAt', 'DESC']],
    });
    // Number, not the string Postgres returns for BIGINT — the detail endpoint
    // says number, and one API must not describe the same field two ways.
    return { rows: rows.map((r) => ({ ...r.toJSON(), totalPaise: Number(r.totalPaise) })), count };
  }

  /** The voucher with the lines it posted, read back from the ledger. */
  static async get(id, transaction) {
    const voucher = await JournalVoucher.findByPk(id, { transaction });
    if (!voucher) throw new NotFoundError('Voucher not found');

    const entries = await JournalEntry.findAll({
      where: { referenceType: REFERENCE_TYPE, referenceId: voucher.id },
      order: [['createdAt', 'ASC']],
      transaction,
    });
    // The first entry is the voucher itself; a later one is its reversal.
    const original = entries.find((e) => !e.reversalOfEntryId) || entries[0];
    const posted = original ? await LedgerService.getJournalEntry(original.id, transaction) : null;
    const factory = await Factory.findByPk(voucher.factoryId, { attributes: ['id', 'name', 'code'], transaction });

    return {
      ...voucher.toJSON(),
      totalPaise: Number(voucher.totalPaise),
      factory: factory ? factory.toJSON() : null,
      journalEntryId: posted?.id || null,
      lines: (posted?.lines || []).map((l) => ({
        id: l.id,
        accountId: l.accountId,
        account: l.account ? accountView(l.account) : null,
        debitPaise: Number(l.debitPaise),
        creditPaise: Number(l.creditPaise),
      })),
    };
  }

  /**
   * Validates and posts a voucher.
   *
   * Rules, each of which exists because the ledger would otherwise accept a
   * posting that quietly breaks something else:
   *
   *  - **No receivable/payable lines.** A customer's or vendor's balance is
   *    also tracked invoice by invoice (allocations). A voucher that moved the
   *    ledger balance would leave the two disagreeing, with no invoice to show
   *    for it. Credit and debit notes, receipts and payments exist for this.
   *  - **Each line is one-sided.** A line with both a debit and a credit is
   *    almost always a typing mistake, and nets to something nobody entered.
   *  - **Contra touches only cash and bank.** That is what a contra voucher
   *    means; anything else belongs in a journal.
   *  - **Accounts must be active.** A closed bank account stops taking entries.
   */
  static async create({ factoryId, voucherType, voucherDate, narration, lines }) {
    if (!SERIES[voucherType]) throw new ValidationError('Voucher type must be JOURNAL or CONTRA');
    assertNotFuture(voucherDate, 'A voucher date');
    if (!lines || lines.length < 2) throw new ValidationError('A voucher needs at least two lines');

    return sequelize.transaction(async (transaction) => {
      const accountIds = [...new Set(lines.map((l) => l.accountId))];
      const accounts = await Account.findAll({ where: { id: { [Op.in]: accountIds } }, transaction });
      const byId = new Map(accounts.map((a) => [a.id, a]));

      for (const [index, line] of lines.entries()) {
        const account = byId.get(line.accountId);
        const position = `Line ${index + 1}`;
        if (!account) throw new NotFoundError(`${position}: account not found`);
        if (!account.isActive) throw new ValidationError(`${position}: ${account.name} is inactive`);
        if (account.isPartyControlAccount) {
          throw new ValidationError(
            `${position}: ${account.name} cannot be used in a voucher — use a receipt, payment, credit note or debit note so the party's invoices stay in step`
          );
        }
        const debit = Number(line.debitPaise || 0);
        const credit = Number(line.creditPaise || 0);
        if (debit < 0 || credit < 0) throw new ValidationError(`${position}: amounts cannot be negative`);
        if (debit > 0 && credit > 0) throw new ValidationError(`${position}: enter either a debit or a credit, not both`);
        if (debit === 0 && credit === 0) throw new ValidationError(`${position}: enter a debit or a credit amount`);
        if (voucherType === 'CONTRA' && !moneyKindOf(account)) {
          throw new ValidationError(`${position}: a contra voucher moves money between cash and bank accounts only — ${account.name} is neither`);
        }
      }

      const totalDebitPaise = addPaise(...lines.map((l) => Number(l.debitPaise || 0)));
      const totalCreditPaise = addPaise(...lines.map((l) => Number(l.creditPaise || 0)));
      if (totalDebitPaise !== totalCreditPaise) {
        throw new ValidationError(`Voucher is not balanced: debits ₹${(totalDebitPaise / 100).toFixed(2)}, credits ₹${(totalCreditPaise / 100).toFixed(2)}`);
      }

      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentType, prefix } = SERIES[voucherType];
      const { documentNumber } = await DocumentNumberingService.allocate(documentType, { factoryId, financialYearId, prefix, transaction });

      const voucher = await JournalVoucher.create(
        {
          factoryId, voucherNumber: documentNumber, voucherType, voucherDate,
          narration: narration.trim(), totalPaise: totalDebitPaise, status: 'POSTED',
          createdBy: getUserId() || null,
        },
        { transaction }
      );

      await LedgerService.postJournal({
        factoryId,
        entryDate: voucherDate,
        referenceType: REFERENCE_TYPE,
        referenceId: voucher.id,
        narration: `${voucherType === 'CONTRA' ? 'Contra' : 'Journal'} ${documentNumber} — ${narration.trim()}`.slice(0, 255),
        lines: lines.map((l) => ({ accountId: l.accountId, debitPaise: Number(l.debitPaise || 0), creditPaise: Number(l.creditPaise || 0) })),
        transaction,
      });

      return this.get(voucher.id, transaction);
    });
  }

  /** Cancelling posts a reversing journal (BR-05) — the original is never edited. */
  static async cancel(id, reason) {
    if (!reason || !String(reason).trim()) throw new ValidationError('A cancellation reason is required');

    return sequelize.transaction(async (transaction) => {
      const voucher = await JournalVoucher.findByPk(id, { transaction, lock: transaction.LOCK.UPDATE });
      if (!voucher) throw new NotFoundError('Voucher not found');
      if (voucher.status !== 'POSTED') throw new ValidationError(`Only a posted voucher can be cancelled (this one is ${voucher.status})`);

      const entry = await JournalEntry.findOne({
        where: { referenceType: REFERENCE_TYPE, referenceId: voucher.id, reversalOfEntryId: null },
        order: [['createdAt', 'ASC']],
        transaction,
      });
      if (entry) {
        await LedgerService.reverseJournal(entry.id, `Voucher ${voucher.voucherNumber} cancelled: ${String(reason).trim()}`, transaction);
      }
      await voucher.update({ status: 'CANCELLED', cancelReason: String(reason).trim() }, { transaction });
      return this.get(id, transaction);
    });
  }
}

module.exports = { JournalVoucherService };
