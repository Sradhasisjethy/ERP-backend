const { Op } = require('sequelize');
const { searchWhere } = require('../../utils/pagination');
const { sequelize } = require('../../config/database');
const { PurchaseOrder } = require('./purchaseOrder.model');
const { PurchaseOrderLine } = require('./purchaseOrderLine.model');
const { GoodsReceipt } = require('./goodsReceipt.model');
const { GoodsReceiptLine } = require('./goodsReceiptLine.model');
const { PurchaseInvoice } = require('./purchaseInvoice.model');
const { Product } = require('../products/product.model');
const { Party } = require('../parties/party.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { addPaise } = require('../../utils/money');

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

class PurchasingService {
  // --- Purchase Orders ---
  static async listPurchaseOrders(page, limit, { factoryId, vendorPartyId, status, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (vendorPartyId) where.vendorPartyId = vendorPartyId;
    if (status) where.status = status;

    if (search) Object.assign(where, searchWhere(search, ['poNumber']));
    return PurchaseOrder.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Party, as: 'vendor' }],
      order: [['orderDate', 'DESC']],
    });
  }

  static async getPurchaseOrder(id) {
    const po = await PurchaseOrder.findByPk(id, {
      include: [
        { model: Party, as: 'vendor' },
        { model: PurchaseOrderLine, as: 'lines', include: [{ model: Product, as: 'product' }] },
      ],
    });
    if (!po) throw new NotFoundError('Purchase order not found');
    return po;
  }

  static async createPurchaseOrder({ lines, ...data }) {
    if (!lines || !lines.length) throw new ValidationError('A purchase order requires at least one line');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('PURCHASE_ORDER', {
        factoryId: data.factoryId,
        financialYearId,
        prefix: 'PO',
        transaction,
      });

      const totalAmountPaise = addPaise(...lines.map((l) => l.orderedQty * l.ratePaise));

      const po = await PurchaseOrder.create({ ...data, poNumber: documentNumber, totalAmountPaise }, { transaction });
      await PurchaseOrderLine.bulkCreate(
        lines.map((line) => ({ ...line, purchaseOrderId: po.id })),
        { transaction, individualHooks: true, validate: true }
      );

      return this.getPurchaseOrder(po.id);
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
  static async listGoodsReceipts(page, limit, { factoryId, vendorPartyId, purchaseOrderId, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (vendorPartyId) where.vendorPartyId = vendorPartyId;
    if (purchaseOrderId) where.purchaseOrderId = purchaseOrderId;

    if (search) Object.assign(where, searchWhere(search, ['grnNumber']));
    return GoodsReceipt.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Party, as: 'vendor' }, { model: PurchaseOrder, as: 'purchaseOrder' }],
      order: [['receiptDate', 'DESC']],
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

      let poLinesById = {};
      if (purchaseOrderId) {
        const po = await PurchaseOrder.findByPk(purchaseOrderId, { include: [{ model: PurchaseOrderLine, as: 'lines' }], transaction });
        if (!po) throw new NotFoundError('Purchase order not found');
        poLinesById = Object.fromEntries(po.lines.map((l) => [l.id, l]));
      }

      const grn = await GoodsReceipt.create({ ...data, purchaseOrderId, grnNumber: documentNumber }, { transaction });

      for (const line of lines) {
        const lotNumber = `${documentNumber}-${line.productId.slice(0, 8)}`;
        const lot = await StockLedgerService.createLot({
          factoryId: data.factoryId,
          productId: line.productId,
          lotNumber,
          originType: 'PURCHASE',
          originId: grn.id,
          originDate: data.receiptDate,
          quantity: line.receivedQty,
          transaction,
        });

        await StockLedgerService.postEntry({
          factoryId: data.factoryId,
          productId: line.productId,
          lotId: lot.id,
          movementType: 'PURCHASE_IN',
          direction: 'IN',
          quantity: line.receivedQty,
          referenceType: 'GoodsReceipt',
          referenceId: grn.id,
          transaction,
        });

        await GoodsReceiptLine.create(
          { ...line, goodsReceiptId: grn.id, lotId: lot.id },
          { transaction }
        );

        if (line.purchaseOrderLineId && poLinesById[line.purchaseOrderLineId]) {
          const poLine = poLinesById[line.purchaseOrderLineId];
          await poLine.update({ receivedQty: Number(poLine.receivedQty) + Number(line.receivedQty) }, { transaction });
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

  // --- Purchase Invoice (lightweight payable, pre-GST — see M20 for full GST invoicing) ---
  static async listPurchaseInvoices(page, limit, { factoryId, vendorPartyId, paymentStatus, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (vendorPartyId) where.vendorPartyId = vendorPartyId;
    if (paymentStatus) where.paymentStatus = paymentStatus;

    if (search) Object.assign(where, searchWhere(search, ['vendorInvoiceNumber']));
    return PurchaseInvoice.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Party, as: 'vendor' }, { model: GoodsReceipt, as: 'goodsReceipt' }],
      order: [['invoiceDate', 'DESC']],
    });
  }

  static async getPurchaseInvoice(id) {
    const invoice = await PurchaseInvoice.findByPk(id, {
      include: [{ model: Party, as: 'vendor' }, { model: GoodsReceipt, as: 'goodsReceipt' }],
    });
    if (!invoice) throw new NotFoundError('Purchase invoice not found');
    return invoice;
  }

  static async createPurchaseInvoice(data) {
    return PurchaseInvoice.create(data);
  }

  static async updatePurchaseInvoicePaymentStatus(id, paymentStatus) {
    const invoice = await this.getPurchaseInvoice(id);
    return invoice.update({ paymentStatus });
  }
}

module.exports = { PurchasingService };
