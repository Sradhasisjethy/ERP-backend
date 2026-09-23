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
const { SalesInvoice } = require('../invoicing/salesInvoice.model');
const { SalesInvoiceLine } = require('../invoicing/salesInvoiceLine.model');
const { determineTax, splitTax } = require('../invoicing/taxDetermination');
const { HsnCode } = require('../products/hsnCode.model');
const { Factory } = require('../factory/factory.model');
const { StockLedgerEntry } = require('../inventory/stockLedgerEntry.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { LedgerService } = require('../ledger/ledger.service');
const { JournalEntry } = require('../ledger/journalEntry.model');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { addPaise } = require('../../utils/money');

const RETURN_MONEY = ['subtotalPaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'totalAmountPaise'];
const RETURN_LINE_MONEY = ['ratePaise', 'taxableAmountPaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'lineTotalPaise'];

/**
 * Money as numbers, not the strings Postgres returns for BIGINT — a list row
 * and a detail read must not describe the same field two different ways.
 */
const numbers = (obj, keys) => Object.fromEntries(keys.filter((k) => k in obj).map((k) => [k, Number(obj[k])]));
const salesReturnView = (record) => {
  const json = typeof record.toJSON === 'function' ? record.toJSON() : record;
  return {
    ...json,
    ...numbers(json, RETURN_MONEY),
    lines: (json.lines || []).map((line) => ({ ...line, ...numbers(line, RETURN_LINE_MONEY), quantity: Number(line.quantity) })),
  };
};

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
    const { rows, count } = await SalesReturn.findAndCountAll({
      where, limit, offset, distinct: true,
      include: [{ model: Party, as: 'customer' }, { model: SalesReturnLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
      order: [['returnDate', 'DESC']],
    });
    return { rows: rows.map(salesReturnView), count };
  }

  static async getSalesReturn(id) {
    const record = await SalesReturn.findByPk(id, {
      include: [{ model: Party, as: 'customer' }, { model: SalesReturnLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
    });
    if (!record) throw new NotFoundError('Sales return not found');
    return salesReturnView(record);
  }

  /**
   * What this customer bought at this factory, and how much of each line can
   * still come back.
   *
   * Recording a return by typing a product, a quantity and a rate invites three
   * mistakes at once: goods that were never sold, more than was sold, and a
   * rate the customer never paid. This gives the screen the invoices to pick
   * from instead, with what is left returnable on every line.
   *
   * Only a return that names its invoice can be attributed to a line. Anything
   * returned without one is reported separately rather than guessed at, so no
   * figure here is quietly wrong.
   */
  static async returnableItems({ factoryId, customerPartyId, limit = 25 }) {
    const invoices = await SalesInvoice.findAll({
      where: { factoryId, customerPartyId, status: 'POSTED' },
      include: [{ model: SalesInvoiceLine, as: 'lines', include: [{ model: Product, as: 'product', attributes: ['id', 'name', 'code'] }] }],
      order: [['invoiceDate', 'DESC'], ['createdAt', 'DESC']],
      limit,
    });

    const posted = await SalesReturn.findAll({
      where: { factoryId, customerPartyId, status: 'POSTED' },
      include: [{ model: SalesReturnLine, as: 'lines' }],
    });

    const returnedByInvoiceProduct = new Map();
    const unlinked = new Map();
    for (const salesReturn of posted) {
      for (const line of salesReturn.lines || []) {
        const qty = Number(line.quantity);
        if (salesReturn.salesInvoiceId) {
          const key = `${salesReturn.salesInvoiceId}|${line.productId}`;
          returnedByInvoiceProduct.set(key, (returnedByInvoiceProduct.get(key) || 0) + qty);
        } else {
          unlinked.set(line.productId, (unlinked.get(line.productId) || 0) + qty);
        }
      }
    }

    const round4 = (n) => Math.round(n * 10000) / 10000;

    const rows = invoices.map((invoice) => {
      const lines = (invoice.lines || []).map((line) => {
        const soldQty = Number(line.quantity);
        const returnedQty = returnedByInvoiceProduct.get(`${invoice.id}|${line.productId}`) || 0;
        return {
          salesInvoiceLineId: line.id,
          productId: line.productId,
          productName: line.product?.name || null,
          productCode: line.product?.code || null,
          hsnCode: line.hsnCode,
          soldQty,
          ratePaise: Number(line.ratePaise),
          // The invoice's own figure for the line, so "rate" can never be read
          // as "line total" on the way back.
          soldValuePaise: Number(line.taxableAmountPaise),
          discountPercent: Number(line.discountPercent || 0),
          gstRatePercent: Number(line.gstRatePercent || 0),
          returnedQty: round4(returnedQty),
          returnableQty: round4(Math.max(soldQty - returnedQty, 0)),
        };
      });
      return {
        invoiceId: invoice.id,
        invoiceNumber: invoice.invoiceNumber,
        invoiceDate: invoice.invoiceDate,
        totalPaise: Number(invoice.totalPaise),
        lines,
        fullyReturned: lines.length > 0 && lines.every((l) => l.returnableQty === 0),
      };
    });

    const unlinkedProducts = unlinked.size
      ? await Product.findAll({ where: { id: [...unlinked.keys()] }, attributes: ['id', 'name'] })
      : [];
    return {
      invoices: rows,
      unlinkedReturns: unlinkedProducts.map((product) => ({
        productId: product.id,
        productName: product.name,
        quantity: round4(unlinked.get(product.id)),
      })),
    };
  }

  /**
   * Refuses a return of more than an invoice still has outstanding.
   *
   * Only runs when the return names its invoice. A return recorded without one
   * (goods sold before go-live, say) has nothing to check against, and leaving
   * it unchecked is honest where inventing a check would not be.
   */
  static async assertWithinInvoice({ salesInvoiceId, factoryId, customerPartyId, lines, transaction }) {
    const invoice = await SalesInvoice.findByPk(salesInvoiceId, {
      include: [{ model: SalesInvoiceLine, as: 'lines' }],
      transaction,
    });
    if (!invoice) throw new NotFoundError('Sales invoice not found');
    if (invoice.customerPartyId !== customerPartyId) throw new ValidationError('That invoice belongs to a different customer');
    if (invoice.factoryId !== factoryId) throw new ValidationError('That invoice was raised at a different factory');
    if (invoice.status !== 'POSTED') {
      throw new ValidationError(`Invoice ${invoice.invoiceNumber} is ${String(invoice.status).toLowerCase()} — nothing can be returned against it`);
    }

    const soldByProduct = new Map();
    for (const line of invoice.lines || []) {
      soldByProduct.set(line.productId, (soldByProduct.get(line.productId) || 0) + Number(line.quantity));
    }

    const earlier = await SalesReturn.findAll({
      where: { salesInvoiceId, status: 'POSTED' },
      include: [{ model: SalesReturnLine, as: 'lines' }],
      transaction,
    });
    const returnedByProduct = new Map();
    for (const salesReturn of earlier) {
      for (const line of salesReturn.lines || []) {
        returnedByProduct.set(line.productId, (returnedByProduct.get(line.productId) || 0) + Number(line.quantity));
      }
    }

    for (const line of lines) {
      const sold = soldByProduct.get(line.productId) || 0;
      const product = await Product.findByPk(line.productId, { attributes: ['name'], transaction });
      const name = product?.name || 'That item';
      if (sold === 0) {
        throw new ValidationError(`${name} is not on invoice ${invoice.invoiceNumber}`);
      }
      const left = sold - (returnedByProduct.get(line.productId) || 0);
      // A hair of tolerance: quantities are DECIMAL(14,4) and a browser can
      // hand back 2.0999999 for 2.1.
      if (Number(line.quantity) > left + 1e-9) {
        throw new ValidationError(
          `Only ${left} of ${name} can still be returned against ${invoice.invoiceNumber} — ${sold} sold, ${sold - left} already returned`
        );
      }
    }
  }

  /**
   * Prices a sales return the way the invoice priced the sale.
   *
   * Goods that were sold with GST come back with it: the customer is credited
   * the tax too, and the output tax the business no longer owes is reversed
   * (s.34 CGST Act). The rate comes from the invoice line where the return
   * names its invoice, so a rate that has changed since cannot rewrite history;
   * otherwise it falls back to the product's HSN rate.
   *
   * CGST/SGST vs IGST follows the same determination as the invoice, from the
   * factory and the customer — a return of an inter-state sale reverses IGST.
   */
  static async priceReturnLines({ factoryId, customerPartyId, salesInvoiceId, lines, transaction }) {
    const [factory, customer] = await Promise.all([
      Factory.findByPk(factoryId, { transaction }),
      Party.findByPk(customerPartyId, { transaction }),
    ]);
    if (!factory) throw new NotFoundError('Factory not found');
    if (!customer) throw new NotFoundError('Customer not found');

    // The rates the goods actually went out at, when there is an invoice.
    const invoiceRates = new Map();
    if (salesInvoiceId) {
      const invoiceLines = await SalesInvoiceLine.findAll({ where: { salesInvoiceId }, transaction });
      for (const line of invoiceLines) invoiceRates.set(line.productId, Number(line.gstRatePercent || 0));
    }

    const rates = [];
    for (const line of lines) {
      let gstRatePercent = invoiceRates.get(line.productId);
      if (gstRatePercent === undefined) {
        const product = await Product.findByPk(line.productId, { include: [{ model: HsnCode, as: 'hsnCode' }], transaction });
        if (!product) throw new NotFoundError(`Product ${line.productId} not found`);
        gstRatePercent = Number(product.hsnCode?.gstRatePercent || 0);
      }
      rates.push(gstRatePercent);
    }

    // Place of supply decides CGST+SGST against IGST, and is only needed when
    // there is tax to split. Goods with no GST rate never needed it on the way
    // out either, so a return of them must not demand it now.
    const isInterState = rates.some((rate) => rate > 0)
      ? determineTax({ factory, shippingAddress: null, customer }).isInterState
      : false;

    const priced = [];
    for (const [index, line] of lines.entries()) {
      const gstRatePercent = rates[index];
      const taxableAmountPaise = Math.round(Number(line.quantity) * Number(line.ratePaise));
      const taxPaise = Math.round((taxableAmountPaise * gstRatePercent) / 100);
      const split = splitTax(taxPaise, isInterState);
      priced.push({
        ...line,
        gstRatePercent,
        taxableAmountPaise,
        ...split,
        lineTotalPaise: taxableAmountPaise + taxPaise,
      });
    }

    const sum = (key) => addPaise(...priced.map((l) => l[key]));
    const totals = {
      subtotalPaise: sum('taxableAmountPaise'),
      cgstPaise: sum('cgstPaise'),
      sgstPaise: sum('sgstPaise'),
      igstPaise: sum('igstPaise'),
    };
    return {
      lines: priced,
      totals: { ...totals, totalAmountPaise: totals.subtotalPaise + totals.cgstPaise + totals.sgstPaise + totals.igstPaise },
    };
  }

  static async createSalesReturn({ factoryId, customerPartyId, salesInvoiceId, returnDate, reason, lines }) {
    if (!lines || !lines.length) throw new ValidationError('A sales return requires at least one line');

    return sequelize.transaction(async (transaction) => {
      if (salesInvoiceId) {
        await this.assertWithinInvoice({ salesInvoiceId, factoryId, customerPartyId, lines, transaction });
      }

      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('SALES_RETURN', { factoryId, financialYearId, prefix: 'SR', transaction });

      const priced = await this.priceReturnLines({ factoryId, customerPartyId, salesInvoiceId, lines, transaction });
      const { subtotalPaise, cgstPaise, sgstPaise, igstPaise, totalAmountPaise } = priced.totals;

      const salesReturn = await SalesReturn.create(
        {
          factoryId, returnNumber: documentNumber, customerPartyId, salesInvoiceId: salesInvoiceId || null,
          returnDate, reason, subtotalPaise, cgstPaise, sgstPaise, igstPaise, totalAmountPaise,
        },
        { transaction }
      );

      for (let i = 0; i < priced.lines.length; i++) {
        const line = priced.lines[i];
        const seq = String(i + 1).padStart(2, '0');
        const lot = await StockLedgerService.createLot({
          factoryId, productId: line.productId, lotNumber: `${documentNumber}-${seq}`,
          originType: 'SALES_RETURN', originId: salesReturn.id, originDate: returnDate, quantity: line.quantity, transaction,
        });
        await StockLedgerService.postEntry({
          factoryId, productId: line.productId, lotId: lot.id, movementType: 'RETURN_IN', direction: 'IN',
          quantity: line.quantity, referenceType: 'SalesReturn', referenceId: salesReturn.id, transaction,
        });
        await SalesReturnLine.create(
          {
            salesReturnId: salesReturn.id, productId: line.productId, quantity: line.quantity, ratePaise: line.ratePaise,
            gstRatePercent: line.gstRatePercent, taxableAmountPaise: line.taxableAmountPaise,
            cgstPaise: line.cgstPaise, sgstPaise: line.sgstPaise, igstPaise: line.igstPaise,
            lineTotalPaise: line.lineTotalPaise, createdLotId: lot.id,
          },
          { transaction }
        );
      }

      await LedgerService.postJournal({
        factoryId, entryDate: returnDate, referenceType: 'SalesReturn', referenceId: salesReturn.id,
        narration: `Sales return ${documentNumber}`,
        // The sale debited the customer with tax and credited GST Output; the
        // return undoes both halves, so the customer is credited the
        // tax-inclusive amount and the output liability comes back down.
        lines: [
          { accountKey: 'SALES_RETURN', debitPaise: subtotalPaise, creditPaise: 0 },
          ...(cgstPaise ? [{ accountKey: 'GST_OUTPUT_CGST', debitPaise: cgstPaise, creditPaise: 0 }] : []),
          ...(sgstPaise ? [{ accountKey: 'GST_OUTPUT_SGST', debitPaise: sgstPaise, creditPaise: 0 }] : []),
          ...(igstPaise ? [{ accountKey: 'GST_OUTPUT_IGST', debitPaise: igstPaise, creditPaise: 0 }] : []),
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
      // getSalesReturn returns a plain view (money as numbers), so the row
      // itself is loaded here to be updated.
      const row = await SalesReturn.findByPk(id, { transaction });
      await row.update({ status: 'CANCELLED' }, { transaction });
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
