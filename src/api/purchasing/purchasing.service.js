const { Op } = require('sequelize');
const { searchWhere } = require('../../utils/pagination');
const { sequelize } = require('../../config/database');
const { PurchaseOrder } = require('./purchaseOrder.model');
const { PurchaseOrderLine } = require('./purchaseOrderLine.model');
const { GoodsReceipt } = require('./goodsReceipt.model');
const { GoodsReceiptLine } = require('./goodsReceiptLine.model');
const { PurchaseInvoice } = require('./purchaseInvoice.model');
const { Product } = require('../products/product.model');
const { Uom } = require('../products/uom.model');
const { Party } = require('../parties/party.model');
const { assertUsableParty, assertUsableProducts } = require('../../core/masterGuards');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { StockLedgerEntry } = require('../inventory/stockLedgerEntry.model');
const { LedgerService } = require('../ledger/ledger.service');
const { JournalEntry } = require('../ledger/journalEntry.model');
const { toOrder } = require('../../utils/pagination');
const { NotFoundError, ValidationError, ConflictError } = require('../../core/AppError');
const { addPaise } = require('../../utils/money');

const PO_SORTABLE = ['poNumber', 'orderDate', 'status', 'totalAmountPaise', 'createdAt'];
const GRN_SORTABLE = ['grnNumber', 'receiptDate', 'status', 'createdAt'];
const PI_SORTABLE = ['vendorInvoiceNumber', 'invoiceDate', 'dueDate', 'amountPaise', 'paymentStatus', 'status', 'createdAt'];

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

class PurchasingService {
  // --- Purchase Orders ---
  static async listPurchaseOrders(page, limit, { vendorPartyId, status, search, sortBy, sortDir, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (vendorPartyId) where.vendorPartyId = vendorPartyId;
    if (status) where.status = status;

    // Searching the vendor's name as well as the PO number is what buyers
    // actually do; `searchWhere` on poNumber alone never found anything by vendor.
    if (search) {
      where[Op.or] = [
        { poNumber: { [Op.iLike]: `%${search}%` } },
        { '$vendor.name$': { [Op.iLike]: `%${search}%` } },
      ];
    }

    return PurchaseOrder.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Party, as: 'vendor' }],
      order: toOrder(sortBy, sortDir, PO_SORTABLE, [['orderDate', 'DESC'], ['poNumber', 'DESC']]),
      subQuery: false,
      distinct: true,
    });
  }

  static async getPurchaseOrder(id) {
    const po = await PurchaseOrder.findByPk(id, {
      include: [
        { model: Party, as: 'vendor' },
        {
          model: PurchaseOrderLine,
          as: 'lines',
          include: [{ model: Product, as: 'product', include: [{ model: Uom, as: 'uom' }] }],
        },
      ],
    });
    if (!po) throw new NotFoundError('Purchase order not found');
    return po;
  }

  /**
   * Two lines for the same product on one order let the same requirement be
   * ordered, received and invoiced twice without either line looking wrong.
   * Mirrors the same rule on the sales side.
   */
  static async validateLines(lines, transaction) {
    if (!lines || !lines.length) throw new ValidationError('A purchase order requires at least one line');
    const ids = lines.map((l) => l.productId);
    const duplicate = ids.find((id, i) => ids.indexOf(id) !== i);
    if (duplicate) {
      const product = await Product.findByPk(duplicate, { attributes: ['name'], transaction });
      throw new ValidationError(
        `"${product ? product.name : 'A product'}" appears on more than one line — combine them into a single quantity`
      );
    }
    await assertUsableProducts(Product, ids, transaction);
  }

  static async createPurchaseOrder({ lines, ...data }) {
    return sequelize.transaction(async (transaction) => {
      await this.validateLines(lines, transaction);
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('PURCHASE_ORDER', {
        factoryId: data.factoryId,
        financialYearId,
        prefix: 'PO',
        transaction,
      });

      // Same reasoning as the sales side: the foreign key cannot tell a vendor
      // from a customer, and an inactive vendor must not receive new orders.
      await assertUsableParty(Party, data.vendorPartyId, 'VENDOR', transaction);

      const totalAmountPaise = addPaise(...lines.map((l) => l.orderedQty * l.ratePaise));

      const po = await PurchaseOrder.create({ ...data, poNumber: documentNumber, totalAmountPaise }, { transaction });
      await PurchaseOrderLine.bulkCreate(
        lines.map((line) => ({ ...line, purchaseOrderId: po.id })),
        { transaction, individualHooks: true, validate: true }
      );

      return this.getPurchaseOrder(po.id);
    });
  }

  /**
   * FR-M11-2: a DRAFT purchase order is still being negotiated.
   *
   * DRAFT only — once confirmed the vendor has been committed to and goods may
   * already be arriving against it, so rewriting the lines would invalidate
   * every receipt matched to them. `factoryId` is fixed because the PO number
   * came from that factory's series.
   */
  static async updatePurchaseOrder(id, { lines, ...data }) {
    return sequelize.transaction(async (transaction) => {
      const po = await PurchaseOrder.findByPk(id, { transaction });
      if (!po) throw new NotFoundError('Purchase order not found');
      if (po.status !== 'DRAFT') {
        throw new ValidationError(
          `Only a DRAFT purchase order can be edited (this one is ${po.status}). Cancel it and raise a new one instead.`
        );
      }
      if (data.vendorPartyId && data.vendorPartyId !== po.vendorPartyId) {
        await assertUsableParty(Party, data.vendorPartyId, 'VENDOR', transaction);
      }
      delete data.factoryId;

      let totalAmountPaise = Number(po.totalAmountPaise);
      if (lines) {
        await this.validateLines(lines, transaction);
        totalAmountPaise = addPaise(...lines.map((l) => l.orderedQty * l.ratePaise));
      }

      await po.update({ ...data, totalAmountPaise }, { transaction });

      if (lines) {
        await PurchaseOrderLine.destroy({ where: { purchaseOrderId: id }, transaction });
        await PurchaseOrderLine.bulkCreate(
          lines.map((line) => ({ ...line, purchaseOrderId: id })),
          { transaction, individualHooks: true, validate: true }
        );
      }

      return this.getPurchaseOrder(id);
    });
  }

  static async confirmPurchaseOrder(id) {
    const po = await this.getPurchaseOrder(id);
    if (po.status !== 'DRAFT') throw new ValidationError('Only a DRAFT purchase order can be confirmed');
    return po.update({ status: 'CONFIRMED' });
  }

  static async cancelPurchaseOrder(id, reason) {
    const po = await this.getPurchaseOrder(id);
    if (['RECEIVED', 'CANCELLED'].includes(po.status)) {
      throw new ValidationError(`Cannot cancel a purchase order in ${po.status} status`);
    }
    if (!reason) throw new ValidationError('A cancellation reason is required');
    return po.update({ status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date() });
  }

  // --- Goods Receipt (GRN) — the actual stock event (BR-01, BR-02) ---
  static async listGoodsReceipts(page, limit, { vendorPartyId, purchaseOrderId, status, search, sortBy, sortDir, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (vendorPartyId) where.vendorPartyId = vendorPartyId;
    if (purchaseOrderId) where.purchaseOrderId = purchaseOrderId;
    if (status) where.status = status;

    if (search) Object.assign(where, searchWhere(search, ['grnNumber']));
    return GoodsReceipt.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Party, as: 'vendor' }, { model: PurchaseOrder, as: 'purchaseOrder' }],
      order: toOrder(sortBy, sortDir, GRN_SORTABLE, [['receiptDate', 'DESC']]),
    });
  }

  static async getGoodsReceipt(id) {
    const grn = await GoodsReceipt.findByPk(id, {
      include: [
        { model: Party, as: 'vendor' },
        { model: PurchaseOrder, as: 'purchaseOrder' },
        { model: GoodsReceiptLine, as: 'lines', include: [{ model: Product, as: 'product' }] },
      ],
    });
    if (!grn) throw new NotFoundError('Goods receipt not found');
    return grn;
  }

  static async createGoodsReceipt({ lines, purchaseOrderId, ...data }) {
    if (!lines || !lines.length) throw new ValidationError('A goods receipt requires at least one line');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('GOODS_RECEIPT', {
        factoryId: data.factoryId,
        financialYearId,
        prefix: 'GRN',
        transaction,
      });

      await assertUsableParty(Party, data.vendorPartyId, 'VENDOR', transaction);
      await assertUsableProducts(Product, lines.map((l) => l.productId), transaction);

      let poLinesById = {};
      if (purchaseOrderId) {
        // FOR UPDATE: two receipts against one order used to read receivedQty
        // concurrently, both see the same figure, and both add their own
        // quantity — so 70 + 70 against a 100 order booked 140 units of stock
        // while the order line recorded 70. Serialising on the order row makes
        // the over-receipt check below the real check.
        const po = await PurchaseOrder.findByPk(purchaseOrderId, { transaction, lock: transaction.LOCK.UPDATE });
        if (!po) throw new NotFoundError('Purchase order not found');
        if (['CANCELLED'].includes(po.status)) {
          throw new ValidationError(`Cannot receive against a purchase order in ${po.status} status`);
        }
        if (po.vendorPartyId !== data.vendorPartyId) {
          throw new ValidationError('This goods receipt names a different vendor from its purchase order');
        }
        if (po.factoryId !== data.factoryId) {
          throw new ValidationError('This goods receipt names a different location from its purchase order');
        }
        const poLines = await PurchaseOrderLine.findAll({ where: { purchaseOrderId }, transaction });
        poLinesById = Object.fromEntries(poLines.map((l) => [l.id, l]));

        // BR-14's purchase-side counterpart: a receipt may not exceed what was
        // ordered. Without this, over-delivery silently inflated stock and the
        // payable, and the three-way match had nothing to flag it against.
        // A 20% tolerance mirrors the dispatch side's configurable slack.
        for (const line of lines) {
          if (!line.purchaseOrderLineId) continue;
          const poLine = poLinesById[line.purchaseOrderLineId];
          if (!poLine) throw new NotFoundError(`Purchase order line ${line.purchaseOrderLineId} not found on this order`);
          const maxAllowed = Number(poLine.orderedQty) * 1.2;
          const projected = Number(poLine.receivedQty) + Number(line.receivedQty);
          if (projected > maxAllowed) {
            throw new ValidationError(
              `Received quantity exceeds the ordered quantity for this line (ordered ${poLine.orderedQty}, already received ${poLine.receivedQty}, this receipt ${line.receivedQty})`
            );
          }
        }
      }

      const grn = await GoodsReceipt.create({ ...data, purchaseOrderId, grnNumber: documentNumber }, { transaction });

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        // QC-01: incoming inspection at the gate. Everything a supplier
        // delivered used to enter available stock, including material a
        // storekeeper would have quarantined — there was no way to say "40
        // bags arrived, 3 were wet". Only the accepted quantity is stocked;
        // the rejected quantity is recorded on the line and never becomes a
        // lot, so it cannot be consumed, sold or counted.
        const rejectedQty = Number(line.rejectedQty || 0);
        const acceptedQty = Number(line.receivedQty) - rejectedQty;

        if (rejectedQty < 0 || acceptedQty < 0) {
          throw new ValidationError(
            `Rejected quantity cannot exceed the received quantity (received ${line.receivedQty}, rejected ${rejectedQty})`
          );
        }
        if (rejectedQty > 0 && !line.rejectionReason) {
          throw new ValidationError('A rejection reason is required when any quantity is rejected');
        }

        // A wholly rejected line still belongs on the receipt — it is the
        // record of what the supplier sent and what was refused — but it must
        // not mint an empty lot, and postEntry rightly refuses a zero movement.
        let lotId = null;
        if (acceptedQty > 0) {
          const seq = String(i + 1).padStart(2, '0');
          const lotNumber = `${documentNumber}-${seq}`;
          const lot = await StockLedgerService.createLot({
            factoryId: data.factoryId,
            productId: line.productId,
            lotNumber,
            originType: 'PURCHASE',
            originId: grn.id,
            originDate: data.receiptDate,
            quantity: acceptedQty,
            transaction,
          });
          lotId = lot.id;

          await StockLedgerService.postEntry({
            factoryId: data.factoryId,
            productId: line.productId,
            lotId: lot.id,
            movementType: 'PURCHASE_IN',
            direction: 'IN',
            quantity: acceptedQty,
            referenceType: 'GoodsReceipt',
            referenceId: grn.id,
            transaction,
          });
        }

        await GoodsReceiptLine.create(
          { ...line, acceptedQty, rejectedQty, goodsReceiptId: grn.id, lotId },
          { transaction }
        );

        if (line.purchaseOrderLineId && poLinesById[line.purchaseOrderLineId]) {
          // Fulfilment counts what was accepted, not what turned up: rejected
          // material is still owed, so the order stays short until it is
          // re-delivered.
          const poLine = poLinesById[line.purchaseOrderLineId];
          await poLine.update({ receivedQty: Number(poLine.receivedQty) + acceptedQty }, { transaction });
        }
      }

      if (purchaseOrderId) {
        const po = await PurchaseOrder.findByPk(purchaseOrderId, { include: [{ model: PurchaseOrderLine, as: 'lines' }], transaction });
        const fullyReceived = po.lines.every((l) => Number(l.receivedQty) >= Number(l.orderedQty));
        const partiallyReceived = po.lines.some((l) => Number(l.receivedQty) > 0);
        await po.update(
          { status: fullyReceived ? 'RECEIVED' : partiallyReceived ? 'PARTIALLY_RECEIVED' : po.status },
          { transaction }
        );
      }

      return this.getGoodsReceipt(grn.id);
    });
  }

  /**
   * Reverses a goods receipt.
   *
   * `GoodsReceipt.status` has carried a CANCELLED value and a `cancelReason`
   * column since the table was created, but nothing could ever set them —
   * there was no service method, controller or route. A goods receipt entered
   * against the wrong product, quantity or vendor was therefore permanent:
   * stock stayed overstated forever and the only workaround was a fake stock
   * adjustment that misattributed the correction.
   *
   * Mirrors the dispatch and purchase-return cancellations: the original
   * ledger entries are reversed (never deleted, BR-05), the order's received
   * quantity is wound back, and the document keeps its number (BR-33).
   */
  static async cancelGoodsReceipt(id, reason) {
    const grn = await this.getGoodsReceipt(id);
    if (grn.status !== 'POSTED') {
      throw new ValidationError(`Only a POSTED goods receipt can be cancelled (current status: ${grn.status})`);
    }
    if (!reason) throw new ValidationError('A cancellation reason is required');

    const invoiced = await PurchaseInvoice.count({ where: { goodsReceiptId: id, status: 'POSTED' } });
    if (invoiced) {
      throw new ValidationError(
        'This goods receipt has been invoiced — cancel the purchase invoice first, or raise a purchase return if the goods went back'
      );
    }

    return sequelize.transaction(async (transaction) => {
      const entries = await StockLedgerEntry.findAll({
        where: { referenceType: 'GoodsReceipt', referenceId: grn.id, movementType: 'PURCHASE_IN' },
        transaction,
      });

      // Reversing posts an OUT against the same lot. If the material has since
      // been consumed, issued or transferred, that OUT cannot be covered and
      // postEntry refuses it — which is the correct answer: the stock is gone,
      // so the right instrument is a purchase return, not a cancellation.
      for (const entry of entries) {
        await StockLedgerService.reverseEntry(entry.id, reason, transaction);
      }

      if (grn.purchaseOrderId) {
        const po = await PurchaseOrder.findByPk(grn.purchaseOrderId, { transaction, lock: transaction.LOCK.UPDATE });
        for (const line of grn.lines) {
          if (!line.purchaseOrderLineId) continue;
          const poLine = await PurchaseOrderLine.findByPk(line.purchaseOrderLineId, { transaction });
          if (!poLine) continue;
          await poLine.update(
            // Mirror of the receipt path: fulfilment advanced by the ACCEPTED
            // quantity, so it must roll back by the same figure. Subtracting
            // receivedQty here would remove more than was ever added whenever
            // any of the delivery had been rejected.
            { receivedQty: Math.max(0, Number(poLine.receivedQty) - Number(line.acceptedQty ?? line.receivedQty)) },
            { transaction }
          );
        }
        if (po && !['CANCELLED'].includes(po.status)) {
          const poLines = await PurchaseOrderLine.findAll({ where: { purchaseOrderId: po.id }, transaction });
          const fully = poLines.every((l) => Number(l.receivedQty) >= Number(l.orderedQty));
          const partly = poLines.some((l) => Number(l.receivedQty) > 0);
          await po.update({ status: fully ? 'RECEIVED' : partly ? 'PARTIALLY_RECEIVED' : 'CONFIRMED' }, { transaction });
        }
      }

      await grn.update({ status: 'CANCELLED', cancelReason: reason }, { transaction });
      return this.getGoodsReceipt(id);
    });
  }

  // --- Purchase Invoice (lightweight payable, pre-GST — see M20 for full GST invoicing) ---
  static async listPurchaseInvoices(page, limit, { vendorPartyId, paymentStatus, status, search, sortBy, sortDir, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (vendorPartyId) where.vendorPartyId = vendorPartyId;
    if (paymentStatus) where.paymentStatus = paymentStatus;
    if (status) where.status = status;

    if (search) Object.assign(where, searchWhere(search, ['vendorInvoiceNumber']));
    return PurchaseInvoice.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Party, as: 'vendor' }, { model: GoodsReceipt, as: 'goodsReceipt' }],
      order: toOrder(sortBy, sortDir, PI_SORTABLE, [['invoiceDate', 'DESC']]),
    });
  }

  static async getPurchaseInvoice(id) {
    const invoice = await PurchaseInvoice.findByPk(id, {
      include: [{ model: Party, as: 'vendor' }, { model: GoodsReceipt, as: 'goodsReceipt' }],
    });
    if (!invoice) throw new NotFoundError('Purchase invoice not found');
    return invoice;
  }

  /**
   * Books a vendor bill against a goods receipt — and, crucially, posts it.
   *
   * This method used to be a bare `PurchaseInvoice.create(data)`: no
   * validation, and **no journal entry at all**. The consequences ran through
   * the whole finance side:
   *
   *   - `ACCOUNTS_PAYABLE` was never credited, so purchases never appeared on
   *     the vendor ledger, the payables report or the trial balance;
   *   - the matching payment *debits* that account, so a vendor who had been
   *     billed and paid ended with a **negative** payable — the books said the
   *     vendor owed us money;
   *   - a purchase return also debits it, compounding the same error;
   *   - `PURCHASE_EXPENSE` (5000) and `GST_INPUT` (1200) sat in the chart of
   *     accounts with nothing ever posting to them.
   *
   * The posting mirrors the purchase-return entry that already existed
   * (Dr PURCHASE_RETURN / Cr AP), so the two now net out correctly:
   *
   *     Dr  Purchase Expense    amount
   *         Cr  Accounts Payable    amount   (against this vendor)
   *
   * Input tax is deliberately not split out here. The invoice carries a single
   * `amountPaise` with no tax breakdown (see the model comment), and GSTR-3B
   * derives ITC by walking the receipt's HSN lines instead. Inventing a split
   * from a number that does not contain one would post a GST_INPUT figure that
   * the return would then contradict.
   */
  static async createPurchaseInvoice(data) {
    return sequelize.transaction(async (transaction) => {
      const grn = await GoodsReceipt.findByPk(data.goodsReceiptId, { transaction, lock: transaction.LOCK.UPDATE });
      if (!grn) throw new NotFoundError('Goods receipt not found');
      if (grn.status !== 'POSTED') {
        throw new ValidationError(`Goods receipt ${grn.grnNumber} is ${grn.status} and cannot be invoiced`);
      }
      // The invoice inherits the economics of its receipt, so the two must
      // agree about who supplied the goods and where they landed.
      if (grn.vendorPartyId !== data.vendorPartyId) {
        throw new ValidationError('This invoice names a different vendor from its goods receipt');
      }
      if (grn.factoryId !== data.factoryId) {
        throw new ValidationError('This invoice names a different location from its goods receipt');
      }

      const existing = await PurchaseInvoice.count({
        where: { goodsReceiptId: data.goodsReceiptId, status: 'POSTED' },
        transaction,
      });
      if (existing) {
        throw new ConflictError(
          `Goods receipt ${grn.grnNumber} has already been invoiced — cancel that invoice first if it was wrong`
        );
      }

      await assertUsableParty(Party, data.vendorPartyId, 'VENDOR', transaction);

      const invoice = await PurchaseInvoice.create({ ...data, status: 'POSTED' }, { transaction });

      await LedgerService.postJournal({
        factoryId: data.factoryId,
        entryDate: data.invoiceDate,
        referenceType: 'PurchaseInvoice',
        referenceId: invoice.id,
        narration: `Purchase invoice ${data.vendorInvoiceNumber}`,
        lines: [
          { accountKey: 'PURCHASE_EXPENSE', debitPaise: Number(data.amountPaise), creditPaise: 0 },
          { accountKey: 'ACCOUNTS_PAYABLE', partyId: data.vendorPartyId, debitPaise: 0, creditPaise: Number(data.amountPaise) },
        ],
        transaction,
      });

      return this.getPurchaseInvoice(invoice.id);
    });
  }

  /**
   * Reverses a vendor bill. Refused once money has been allocated against it —
   * cancelling then would unwind the payable while the payment's debit stayed
   * behind, leaving the vendor's ledger showing a balance in our favour. The
   * payment has to be cancelled first, or a debit note raised.
   */
  static async cancelPurchaseInvoice(id, reason) {
    const invoice = await this.getPurchaseInvoice(id);
    if (invoice.status !== 'POSTED') {
      throw new ValidationError(`Only a POSTED purchase invoice can be cancelled (current status: ${invoice.status})`);
    }
    if (!reason) throw new ValidationError('A cancellation reason is required');

    const { getInvoiceAllocatedAmount } = require('../payments/payments.service');
    const allocated = await getInvoiceAllocatedAmount('PURCHASE', invoice.id);
    if (allocated > 0) {
      throw new ValidationError(
        `This invoice cannot be cancelled — ${allocated} paise has already been paid against it. ` +
          'Cancel the payment first, or raise a debit note instead.'
      );
    }

    return sequelize.transaction(async (transaction) => {
      const entry = await JournalEntry.findOne({
        where: { referenceType: 'PurchaseInvoice', referenceId: invoice.id },
        transaction,
      });
      if (entry) await LedgerService.reverseJournal(entry.id, reason, transaction);

      await invoice.update({ status: 'CANCELLED', cancelReason: reason }, { transaction });
      return this.getPurchaseInvoice(id);
    });
  }
}

module.exports = { PurchasingService };
