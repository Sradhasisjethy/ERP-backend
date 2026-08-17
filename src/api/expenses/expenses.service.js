const { sequelize } = require('../../config/database');
const { searchWhere } = require('../../utils/pagination');
const { Expense } = require('./expense.model');
const { Party } = require('../parties/party.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { LedgerService } = require('../ledger/ledger.service');
const { JournalEntry } = require('../ledger/journalEntry.model');
const { NotFoundError, ValidationError } = require('../../core/AppError');

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

class ExpensesService {
  static async list(page, limit, { factoryId, category, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (category) where.category = category;
    if (search) Object.assign(where, searchWhere(search, ['expenseNumber', 'category', 'description']));
    return Expense.findAndCountAll({
      where, limit, offset, include: [{ model: Party, as: 'paidToParty' }], order: [['expenseDate', 'DESC']],
    });
  }

  static async get(id) {
    const record = await Expense.findByPk(id, { include: [{ model: Party, as: 'paidToParty' }] });
    if (!record) throw new NotFoundError('Expense not found');
    return record;
  }

  static async createExpense({ factoryId, expenseDate, category, mode, amountPaise, paidToPartyId, description }) {
    if (!amountPaise || amountPaise <= 0) throw new ValidationError('amountPaise must be positive');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('EXPENSE', { factoryId, financialYearId, prefix: 'EXP', transaction });

      const expense = await Expense.create(
        { factoryId, expenseNumber: documentNumber, expenseDate, category, mode, amountPaise, paidToPartyId: paidToPartyId || null, description },
        { transaction }
      );

      await LedgerService.postJournal({
        factoryId, entryDate: expenseDate, referenceType: 'Expense', referenceId: expense.id,
        narration: `Expense ${documentNumber} — ${category}`,
        lines: [
          { accountKey: 'FACTORY_EXPENSE', debitPaise: amountPaise, creditPaise: 0 },
          { accountKey: mode === 'CASH' ? 'CASH' : 'BANK', debitPaise: 0, creditPaise: amountPaise },
        ],
        transaction,
      });

      return this.get(expense.id);
    });
  }

  static async cancelExpense(id, reason) {
    const expense = await this.get(id);
    if (expense.status !== 'POSTED') throw new ValidationError(`Only a POSTED expense can be cancelled (current status: ${expense.status})`);
    if (!reason) throw new ValidationError('A cancellation reason is required');

    return sequelize.transaction(async (transaction) => {
      const entry = await JournalEntry.findOne({ where: { referenceType: 'Expense', referenceId: expense.id }, transaction });
      if (entry) await LedgerService.reverseJournal(entry.id, reason, transaction);
      await expense.update({ status: 'CANCELLED' }, { transaction });
      return this.get(id);
    });
  }
}

module.exports = { ExpensesService };
