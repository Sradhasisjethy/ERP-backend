const { Op, fn, col } = require('sequelize');
const { searchWhere } = require('../../utils/pagination');
const { sequelize } = require('../../config/database');
const { Receipt } = require('./receipt.model');
const { Payment } = require('./payment.model');
const { PaymentAllocation } = require('./paymentAllocation.model');
const { SalesInvoice } = require('../invoicing/salesInvoice.model');
const { PurchaseInvoice } = require('../purchasing/purchaseInvoice.model');
const { Party } = require('../parties/party.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { LedgerService } = require('../ledger/ledger.service');
const { JournalEntry } = require('../ledger/journalEntry.model');
const { Cheque } = require('./cheque.model');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { addPaise } = require('../../utils/money');

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

const modeAccountKey = (mode) => (mode === 'CASH' ? 'CASH' : 'BANK');

const validateModes = (modes, totalAmountPaise) => {
  if (!modes || !modes.length) throw new ValidationError('At least one payment mode is required');
  const sum = addPaise(...modes.map((m) => m.amountPaise));
  if (sum !== totalAmountPaise) {
    throw new ValidationError(`Sum of payment modes (${sum} paise) must equal the total amount (${totalAmountPaise} paise)`);
  }
};

// BR-20: how much of an invoice's total is already covered by POSTED
// receipts/payments — the rest is what allocation may still draw against.
const getInvoiceAllocatedAmount = async (invoiceType, invoiceId, { excludeReceiptId, excludePaymentId, transaction } = {}) => {
  const where = { invoiceType, invoiceId };
  const result = await PaymentAllocation.findOne({
    attributes: [[fn('COALESCE', fn('SUM', col('PaymentAllocation.allocatedAmountPaise')), 0), 'total']],
    where,
    include: [
      { model: Receipt, as: 'receipt', attributes: [], required: false, where: { status: 'POSTED', ...(excludeReceiptId ? { id: { [Op.ne]: excludeReceiptId } } : {}) } },
      { model: Payment, as: 'payment', attributes: [], required: false, where: { status: 'POSTED', ...(excludePaymentId ? { id: { [Op.ne]: excludePaymentId } } : {}) } },
    ],
    transaction,
    raw: true,
  });
  return Number(result?.total || 0);
};

/**
 * Creates a Cheque record for every cheque-mode line on a receipt/payment, so
 * the money can be followed to clearance (FR-M18-7). Modes other than CHEQUE
 * settle immediately and need no tracking.
 */
const createChequesFor = async ({ modes, factoryId, partyId, direction, date, receiptId, paymentId, transaction }) => {
  const chequeModes = (modes || []).filter((m) => m.mode === 'CHEQUE');
  for (const mode of chequeModes) {
    await Cheque.create(
      {
        factoryId, partyId, direction,
        chequeNumber: mode.chequeNumber || mode.reference || 'UNSPECIFIED',
        bankName: mode.bankName || null,
        chequeDate: mode.chequeDate || date,
        amountPaise: mode.amountPaise,
        status: 'ISSUED',
        receiptId: receiptId || null,
        paymentId: paymentId || null,
      },
      { transaction }
    );
  }
};

class PaymentsService {
  // --- Receipts (customer money in) ---
  static async listReceipts(page, limit, { factoryId, customerPartyId, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (customerPartyId) where.customerPartyId = customerPartyId;
    if (search) Object.assign(where, searchWhere(search, ['receiptNumber']));
    return Receipt.findAndCountAll({
      where, limit, offset,
      include: [{ model: Party, as: 'customer' }, { model: PaymentAllocation, as: 'allocations' }],
      order: [['receiptDate', 'DESC']],
    });
  }

  static async getReceipt(id) {
    const receipt = await Receipt.findByPk(id, { include: [{ model: Party, as: 'customer' }, { model: PaymentAllocation, as: 'allocations' }] });
    if (!receipt) throw new NotFoundError('Receipt not found');
    return receipt;
  }

  static async createReceipt({ factoryId, customerPartyId, receiptDate, modes, allocations }) {
    return sequelize.transaction(async (transaction) => {
      const totalAmountPaise = addPaise(...modes.map((m) => m.amountPaise));
      validateModes(modes, totalAmountPaise);

      const allocationTotal = addPaise(...(allocations || []).map((a) => a.allocatedAmountPaise));
      if (allocationTotal > totalAmountPaise) throw new ValidationError('Allocated amount cannot exceed the receipt total');

      for (const alloc of allocations || []) {
        const invoice = await SalesInvoice.findByPk(alloc.invoiceId, { transaction });
        if (!invoice) throw new NotFoundError('Sales invoice not found');
        const alreadyAllocated = await getInvoiceAllocatedAmount('SALES', alloc.invoiceId, { transaction });
        if (alreadyAllocated + alloc.allocatedAmountPaise > invoice.totalPaise) {
          throw new ValidationError(`Allocation exceeds the outstanding balance on invoice ${invoice.invoiceNumber}`);
        }
      }

      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('RECEIPT', { factoryId, financialYearId, prefix: 'RCP', transaction });

      const receipt = await Receipt.create(
        { factoryId, customerPartyId, receiptNumber: documentNumber, receiptDate, modes, totalAmountPaise, unallocatedAmountPaise: totalAmountPaise - allocationTotal },
        { transaction }
      );

      if (allocations && allocations.length) {
        await PaymentAllocation.bulkCreate(
          allocations.map((a) => ({ receiptId: receipt.id, invoiceType: 'SALES', invoiceId: a.invoiceId, allocatedAmountPaise: a.allocatedAmountPaise })),
          { transaction, individualHooks: true, validate: true }
        );
      }

      const journalLines = [{ accountKey: 'ACCOUNTS_RECEIVABLE', partyId: customerPartyId, debitPaise: 0, creditPaise: totalAmountPaise }];
      for (const m of modes) journalLines.push({ accountKey: modeAccountKey(m.mode), debitPaise: m.amountPaise, creditPaise: 0 });

      await LedgerService.postJournal({
        factoryId, entryDate: receiptDate, referenceType: 'Receipt', referenceId: receipt.id,
        narration: `Receipt ${documentNumber}`, lines: journalLines, transaction,
      });

      // FR-M18-7: a cheque isn't money in the bank yet. The receipt posts now
      // (the customer's dues are settled on the strength of it), but the
      // cheque is tracked separately so a bounce can reverse this later.
      await createChequesFor({
        modes, factoryId, partyId: customerPartyId, direction: 'INBOUND',
        date: receiptDate, receiptId: receipt.id, transaction,
      });

      return this.getReceipt(receipt.id);
    });
  }

  static async cancelReceipt(id, reason) {
    const receipt = await this.getReceipt(id);
    if (receipt.status !== 'POSTED') throw new ValidationError(`Only a POSTED receipt can be cancelled (current status: ${receipt.status})`);
    if (!reason) throw new ValidationError('A cancellation reason is required');

    return sequelize.transaction(async (transaction) => {
      const entry = await JournalEntry.findOne({ where: { referenceType: 'Receipt', referenceId: receipt.id }, transaction });
      if (entry) await LedgerService.reverseJournal(entry.id, reason, transaction);
      await receipt.update({ status: 'CANCELLED' }, { transaction });
      return this.getReceipt(id);
    });
  }

  // --- Payments (money out to vendor/contractor/labour) ---
  static async listPayments(page, limit, { factoryId, partyId, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (partyId) where.partyId = partyId;
    if (search) Object.assign(where, searchWhere(search, ['paymentNumber']));
    return Payment.findAndCountAll({
      where, limit, offset,
      include: [{ model: Party, as: 'party' }, { model: PaymentAllocation, as: 'allocations' }],
      order: [['paymentDate', 'DESC']],
    });
  }

  static async getPayment(id) {
    const payment = await Payment.findByPk(id, { include: [{ model: Party, as: 'party' }, { model: PaymentAllocation, as: 'allocations' }] });
    if (!payment) throw new NotFoundError('Payment not found');
    return payment;
  }

  static async createPayment({ factoryId, partyId, paymentDate, modes, allocations }) {
    return sequelize.transaction(async (transaction) => {
      const totalAmountPaise = addPaise(...modes.map((m) => m.amountPaise));
      validateModes(modes, totalAmountPaise);

      const allocationTotal = addPaise(...(allocations || []).map((a) => a.allocatedAmountPaise));
      if (allocationTotal > totalAmountPaise) throw new ValidationError('Allocated amount cannot exceed the payment total');

      const touchedInvoices = [];
      for (const alloc of allocations || []) {
        const invoice = await PurchaseInvoice.findByPk(alloc.invoiceId, { transaction });
        if (!invoice) throw new NotFoundError('Purchase invoice not found');
        const alreadyAllocated = await getInvoiceAllocatedAmount('PURCHASE', alloc.invoiceId, { transaction });
        if (alreadyAllocated + alloc.allocatedAmountPaise > invoice.amountPaise) {
          throw new ValidationError(`Allocation exceeds the outstanding balance on invoice ${invoice.vendorInvoiceNumber}`);
        }
        touchedInvoices.push(invoice);
      }

      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('PAYMENT', { factoryId, financialYearId, prefix: 'PMT', transaction });

      const payment = await Payment.create(
        { factoryId, partyId, paymentNumber: documentNumber, paymentDate, modes, totalAmountPaise, unallocatedAmountPaise: totalAmountPaise - allocationTotal },
        { transaction }
      );

      if (allocations && allocations.length) {
        await PaymentAllocation.bulkCreate(
          allocations.map((a) => ({ paymentId: payment.id, invoiceType: 'PURCHASE', invoiceId: a.invoiceId, allocatedAmountPaise: a.allocatedAmountPaise })),
          { transaction, individualHooks: true, validate: true }
        );
      }

      // Keep M12's PurchaseInvoice.paymentStatus in sync now that allocation is real.
      for (const invoice of touchedInvoices) {
        const totalAllocated = await getInvoiceAllocatedAmount('PURCHASE', invoice.id, { transaction });
        const paymentStatus = totalAllocated >= invoice.amountPaise ? 'PAID' : totalAllocated > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
        await invoice.update({ paymentStatus }, { transaction });
      }

      const journalLines = [{ accountKey: 'ACCOUNTS_PAYABLE', partyId, debitPaise: totalAmountPaise, creditPaise: 0 }];
      for (const m of modes) journalLines.push({ accountKey: modeAccountKey(m.mode), debitPaise: 0, creditPaise: m.amountPaise });

      await LedgerService.postJournal({
        factoryId, entryDate: paymentDate, referenceType: 'Payment', referenceId: payment.id,
        narration: `Payment ${documentNumber}`, lines: journalLines, transaction,
      });

      await createChequesFor({
        modes, factoryId, partyId, direction: 'OUTBOUND',
        date: paymentDate, paymentId: payment.id, transaction,
      });

      return this.getPayment(payment.id);
    });
  }

  static async cancelPayment(id, reason) {
    const payment = await this.getPayment(id);
    if (payment.status !== 'POSTED') throw new ValidationError(`Only a POSTED payment can be cancelled (current status: ${payment.status})`);
    if (!reason) throw new ValidationError('A cancellation reason is required');

    return sequelize.transaction(async (transaction) => {
      const entry = await JournalEntry.findOne({ where: { referenceType: 'Payment', referenceId: payment.id }, transaction });
      if (entry) await LedgerService.reverseJournal(entry.id, reason, transaction);

      for (const alloc of payment.allocations) {
        const invoice = await PurchaseInvoice.findByPk(alloc.invoiceId, { transaction });
        if (invoice) {
          const totalAllocated = await getInvoiceAllocatedAmount('PURCHASE', invoice.id, { excludePaymentId: payment.id, transaction });
          const paymentStatus = totalAllocated >= invoice.amountPaise ? 'PAID' : totalAllocated > 0 ? 'PARTIALLY_PAID' : 'UNPAID';
          await invoice.update({ paymentStatus }, { transaction });
        }
      }

      await payment.update({ status: 'CANCELLED' }, { transaction });
      return this.getPayment(id);
    });
  }
}

module.exports = { PaymentsService, getInvoiceAllocatedAmount };
