const { sequelize } = require('../../config/database');
const { searchWhere } = require('../../utils/pagination');
const { SalesReturn } = require('./salesReturn.model');
const { SalesReturnLine } = require('./salesReturnLine.model');
const { PurchaseReturn } = require('./purchaseReturn.model');
const { PurchaseReturnLine } = require('./purchaseReturnLine.model');
const { CreditNote } = require('./creditNote.model');
const { DebitNote } = require('./debitNote.model');
const { Product } = require('../products/product.model');
const { Party } = require('../parties/party.model');
const { StockLedgerEntry } = require('../inventory/stockLedgerEntry.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { LedgerService } = require('../ledger/ledger.service');
const { JournalEntry } = require('../ledger/journalEntry.model');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { addPaise } = require('../../utils/money');

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

const reverseJournalFor = async (referenceType, referenceId, reason, transaction) => {
  const entry = await JournalEntry.findOne({ where: { referenceType, referenceId }, transaction });
  if (entry) await LedgerService.reverseJournal(entry.id, reason, transaction);
};

class ReturnsService {
  // --- Sales Return (M22) ---
  static async listSalesReturns(page, limit, { customerPartyId, search , baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (customerPartyId) where.customerPartyId = customerPartyId;
    if (search) Object.assign(where, searchWhere(search, ['returnNumber', 'reason']));
    return SalesReturn.findAndCountAll({
      where, limit, offset,
      include: [{ model: Party, as: 'customer' }, { model: SalesReturnLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
      order: [['returnDate', 'DESC']],
    });
  }

  static async getSalesReturn(id) {
    const record = await SalesReturn.findByPk(id, {
      include: [{ model: Party, as: 'customer' }, { model: SalesReturnLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
    });
    if (!record) throw new NotFoundError('Sales return not found');
    return record;
  }

  static async createSalesReturn({ factoryId, customerPartyId, salesInvoiceId, returnDate, reason, lines }) {
    if (!lines || !lines.length) throw new ValidationError('A sales return requires at least one line');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('SALES_RETURN', { factoryId, financialYearId, prefix: 'SR', transaction });

      const totalAmountPaise = addPaise(...lines.map((l) => l.quantity * l.ratePaise));
      const salesReturn = await SalesReturn.create(
        { factoryId, returnNumber: documentNumber, customerPartyId, salesInvoiceId: salesInvoiceId || null, returnDate, reason, totalAmountPaise },
        { transaction }
      );

      for (const line of lines) {
        const lot = await StockLedgerService.createLot({
          factoryId, productId: line.productId, lotNumber: `${documentNumber}-${line.productId.slice(0, 8)}`,
          originType: 'SALES_RETURN', originId: salesReturn.id, originDate: returnDate, quantity: line.quantity, transaction,
        });
        await StockLedgerService.postEntry({
          factoryId, productId: line.productId, lotId: lot.id, movementType: 'RETURN_IN', direction: 'IN',
          quantity: line.quantity, referenceType: 'SalesReturn', referenceId: salesReturn.id, transaction,
        });
        await SalesReturnLine.create(
          { salesReturnId: salesReturn.id, productId: line.productId, quantity: line.quantity, ratePaise: line.ratePaise, createdLotId: lot.id },
          { transaction }
        );
      }

      await LedgerService.postJournal({
        factoryId, entryDate: returnDate, referenceType: 'SalesReturn', referenceId: salesReturn.id,
        narration: `Sales return ${documentNumber}`,
        lines: [
          { accountKey: 'SALES_RETURN', debitPaise: totalAmountPaise, creditPaise: 0 },
          { accountKey: 'ACCOUNTS_RECEIVABLE', partyId: customerPartyId, debitPaise: 0, creditPaise: totalAmountPaise },
        ],
        transaction,
      });

      return this.getSalesReturn(salesReturn.id);
    });
  }

  static async cancelSalesReturn(id, reason) {
    const record = await this.getSalesReturn(id);
    if (record.status !== 'POSTED') throw new ValidationError(`Only a POSTED sales return can be cancelled (current status: ${record.status})`);
    if (!reason) throw new ValidationError('A cancellation reason is required');

    return sequelize.transaction(async (transaction) => {
      for (const line of record.lines) {
        await StockLedgerService.consumeFifo({
          factoryId: record.factoryId, productId: line.productId, quantity: line.quantity,
          movementType: 'RETURN_OUT', referenceType: 'SalesReturn', referenceId: record.id,
          overrideLotId: line.createdLotId, overrideReason: 'Sales return cancelled', transaction,
        });
      }
      await reverseJournalFor('SalesReturn', record.id, reason, transaction);
      await record.update({ status: 'CANCELLED' }, { transaction });
      return this.getSalesReturn(id);
    });
  }

  // --- Purchase Return (M22) ---
  static async listPurchaseReturns(page, limit, { vendorPartyId, search , baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (vendorPartyId) where.vendorPartyId = vendorPartyId;
    if (search) Object.assign(where, searchWhere(search, ['returnNumber', 'reason']));
    return PurchaseReturn.findAndCountAll({
      where, limit, offset,
      include: [{ model: Party, as: 'vendor' }, { model: PurchaseReturnLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
      order: [['returnDate', 'DESC']],
    });
  }

  static async getPurchaseReturn(id) {
    const record = await PurchaseReturn.findByPk(id, {
      include: [{ model: Party, as: 'vendor' }, { model: PurchaseReturnLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
    });
    if (!record) throw new NotFoundError('Purchase return not found');
    return record;
  }

  static async createPurchaseReturn({ factoryId, vendorPartyId, returnDate, reason, lines }) {
    if (!lines || !lines.length) throw new ValidationError('A purchase return requires at least one line');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('PURCHASE_RETURN', { factoryId, financialYearId, prefix: 'PR', transaction });

      const totalAmountPaise = addPaise(...lines.map((l) => l.quantity * l.ratePaise));
      const purchaseReturn = await PurchaseReturn.create({ factoryId, returnNumber: documentNumber, vendorPartyId, returnDate, reason, totalAmountPaise }, { transaction });

      for (const line of lines) {
        await StockLedgerService.consumeFifo({
          factoryId, productId: line.productId, quantity: line.quantity, movementType: 'RETURN_OUT',
          referenceType: 'PurchaseReturn', referenceId: purchaseReturn.id,
          overrideLotId: line.lotId, overrideReason: line.lotId ? (line.overrideReason || reason) : undefined,
          transaction,
        });
        await PurchaseReturnLine.create(
          { purchaseReturnId: purchaseReturn.id, productId: line.productId, quantity: line.quantity, ratePaise: line.ratePaise },
          { transaction }
        );
      }

      await LedgerService.postJournal({
        factoryId, entryDate: returnDate, referenceType: 'PurchaseReturn', referenceId: purchaseReturn.id,
        narration: `Purchase return ${documentNumber}`,
        lines: [
          { accountKey: 'ACCOUNTS_PAYABLE', partyId: vendorPartyId, debitPaise: totalAmountPaise, creditPaise: 0 },
          { accountKey: 'PURCHASE_RETURN', debitPaise: 0, creditPaise: totalAmountPaise },
        ],
        transaction,
      });

      return this.getPurchaseReturn(purchaseReturn.id);
    });
  }

  static async cancelPurchaseReturn(id, reason) {
    const record = await this.getPurchaseReturn(id);
    if (record.status !== 'POSTED') throw new ValidationError(`Only a POSTED purchase return can be cancelled (current status: ${record.status})`);
    if (!reason) throw new ValidationError('A cancellation reason is required');

    return sequelize.transaction(async (transaction) => {
      const entries = await StockLedgerEntry.findAll({
        where: { referenceType: 'PurchaseReturn', referenceId: record.id, movementType: 'RETURN_OUT' },
        transaction,
      });
      for (const entry of entries) {
        await StockLedgerService.reverseEntry(entry.id, reason, transaction);
      }
      await reverseJournalFor('PurchaseReturn', record.id, reason, transaction);
      await record.update({ status: 'CANCELLED' }, { transaction });
      return this.getPurchaseReturn(id);
    });
  }

  // --- Credit Note (M23) ---
  static async listCreditNotes(page, limit, { customerPartyId, search , baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (customerPartyId) where.customerPartyId = customerPartyId;
    if (search) Object.assign(where, searchWhere(search, ['noteNumber', 'reason']));
    return CreditNote.findAndCountAll({ where, limit, offset, include: [{ model: Party, as: 'customer' }], order: [['noteDate', 'DESC']] });
  }

  static async getCreditNote(id) {
    const record = await CreditNote.findByPk(id, { include: [{ model: Party, as: 'customer' }] });
    if (!record) throw new NotFoundError('Credit note not found');
    return record;
  }

  static async createCreditNote({ factoryId, customerPartyId, salesInvoiceId, noteDate, reason, amountPaise }) {
    if (!amountPaise || amountPaise <= 0) throw new ValidationError('amountPaise must be positive');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('CREDIT_NOTE', { factoryId, financialYearId, prefix: 'CN', transaction });

      const note = await CreditNote.create(
        { factoryId, customerPartyId, salesInvoiceId: salesInvoiceId || null, noteNumber: documentNumber, noteDate, reason, amountPaise },
        { transaction }
      );

      await LedgerService.postJournal({
        factoryId, entryDate: noteDate, referenceType: 'CreditNote', referenceId: note.id,
        narration: `Credit note ${documentNumber}: ${reason}`,
        lines: [
          { accountKey: 'SALES_RETURN', debitPaise: amountPaise, creditPaise: 0 },
          { accountKey: 'ACCOUNTS_RECEIVABLE', partyId: customerPartyId, debitPaise: 0, creditPaise: amountPaise },
        ],
        transaction,
      });

      return this.getCreditNote(note.id);
    });
  }

  static async cancelCreditNote(id, reason) {
    const record = await this.getCreditNote(id);
    if (record.status !== 'POSTED') throw new ValidationError(`Only a POSTED credit note can be cancelled (current status: ${record.status})`);
    if (!reason) throw new ValidationError('A cancellation reason is required');

    return sequelize.transaction(async (transaction) => {
      await reverseJournalFor('CreditNote', record.id, reason, transaction);
      await record.update({ status: 'CANCELLED' }, { transaction });
      return this.getCreditNote(id);
    });
  }

  // --- Debit Note (M23) ---
  static async listDebitNotes(page, limit, { vendorPartyId, search , baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (vendorPartyId) where.vendorPartyId = vendorPartyId;
    if (search) Object.assign(where, searchWhere(search, ['noteNumber', 'reason']));
    return DebitNote.findAndCountAll({ where, limit, offset, include: [{ model: Party, as: 'vendor' }], order: [['noteDate', 'DESC']] });
  }

  static async getDebitNote(id) {
    const record = await DebitNote.findByPk(id, { include: [{ model: Party, as: 'vendor' }] });
    if (!record) throw new NotFoundError('Debit note not found');
    return record;
  }

  static async createDebitNote({ factoryId, vendorPartyId, noteDate, reason, amountPaise }) {
    if (!amountPaise || amountPaise <= 0) throw new ValidationError('amountPaise must be positive');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('DEBIT_NOTE', { factoryId, financialYearId, prefix: 'DN', transaction });

      const note = await DebitNote.create({ factoryId, vendorPartyId, noteNumber: documentNumber, noteDate, reason, amountPaise }, { transaction });

      await LedgerService.postJournal({
        factoryId, entryDate: noteDate, referenceType: 'DebitNote', referenceId: note.id,
        narration: `Debit note ${documentNumber}: ${reason}`,
        lines: [
          { accountKey: 'ACCOUNTS_PAYABLE', partyId: vendorPartyId, debitPaise: amountPaise, creditPaise: 0 },
          { accountKey: 'PURCHASE_RETURN', debitPaise: 0, creditPaise: amountPaise },
        ],
        transaction,
      });

      return this.getDebitNote(note.id);
    });
  }

  static async cancelDebitNote(id, reason) {
    const record = await this.getDebitNote(id);
    if (record.status !== 'POSTED') throw new ValidationError(`Only a POSTED debit note can be cancelled (current status: ${record.status})`);
    if (!reason) throw new ValidationError('A cancellation reason is required');

    return sequelize.transaction(async (transaction) => {
      await reverseJournalFor('DebitNote', record.id, reason, transaction);
      await record.update({ status: 'CANCELLED' }, { transaction });
      return this.getDebitNote(id);
    });
  }
}

module.exports = { ReturnsService };
