const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { PurchaseIndent, PurchaseIndentLine } = require('./purchaseIndent.model');
const { PurchaseOrder } = require('./purchaseOrder.model');
const { PurchaseOrderLine } = require('./purchaseOrderLine.model');
const { GoodsReceipt } = require('./goodsReceipt.model');
const { GoodsReceiptLine } = require('./goodsReceiptLine.model');
const { PurchaseInvoice } = require('./purchaseInvoice.model');
const { Product } = require('../products/product.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { searchWhere } = require('../../utils/pagination');
const { NotFoundError, ValidationError } = require('../../core/AppError');
const { getUserId } = require('../../core/tenantContext');

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

const withLines = { include: [{ model: PurchaseIndentLine, as: 'lines', include: [{ model: Product, as: 'product' }] }] };

class IndentService {
  static async list(page, limit, { factoryId, status, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (status) where.status = status;
    if (search) Object.assign(where, searchWhere(search, ['indentNumber', 'remarks']));
    return PurchaseIndent.findAndCountAll({ where, limit, offset, ...withLines, order: [['indentDate', 'DESC']] });
  }

  static async get(id) {
    const indent = await PurchaseIndent.findByPk(id, withLines);
    if (!indent) throw new NotFoundError('Purchase indent not found');
    return indent;
  }

  static async create({ factoryId, indentDate, requiredByDate, remarks, lines }) {
    if (!lines?.length) throw new ValidationError('An indent requires at least one line');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('PURCHASE_INDENT', {
        factoryId, financialYearId, prefix: 'IND', transaction,
      });

      const indent = await PurchaseIndent.create(
        { factoryId, indentNumber: documentNumber, indentDate, requiredByDate, remarks, status: 'PENDING_APPROVAL' },
        { transaction }
      );

      await PurchaseIndentLine.bulkCreate(
        lines.map((l) => ({ purchaseIndentId: indent.id, productId: l.productId, quantity: l.quantity, remarks: l.remarks })),
        { transaction, individualHooks: true, validate: true }
      );

      return this.get(indent.id);
    });
  }

  static async approve(id) {
    const indent = await this.get(id);
    if (indent.status !== 'PENDING_APPROVAL') {
      throw new ValidationError(`Only an indent awaiting approval can be approved (this one is ${indent.status})`);
    }
    await indent.update({ status: 'APPROVED', approvedBy: getUserId() || null, approvedAt: new Date() });
    return this.get(id);
  }

  static async reject(id, reason) {
    if (!reason) throw new ValidationError('A rejection reason is required');
    const indent = await this.get(id);
    if (indent.status !== 'PENDING_APPROVAL') {
      throw new ValidationError(`Only an indent awaiting approval can be rejected (this one is ${indent.status})`);
    }
    await indent.update({ status: 'REJECTED', rejectionReason: reason, approvedBy: getUserId() || null, approvedAt: new Date() });
    return this.get(id);
  }

  /**
   * FR-M11-1 -> FR-M11-2: turns an approved indent into a purchase order.
   * Rates come from the buyer at this point (the indent asks for quantity, not
   * price), so they're supplied per line here.
   */
  static async convertToPurchaseOrder(id, { vendorPartyId, orderDate, expectedDate, lineRates = [] }) {
    const indent = await this.get(id);
    if (indent.status !== 'APPROVED') throw new ValidationError('Only an APPROVED indent can be converted to a purchase order');
    if (indent.purchaseOrderId) throw new ValidationError('This indent has already been converted to a purchase order');

    const rateByProduct = new Map(lineRates.map((r) => [r.productId, Number(r.ratePaise)]));
    const missing = indent.lines.filter((l) => !rateByProduct.has(l.productId));
    if (missing.length) {
      throw new ValidationError(`A rate is required for every line — missing for ${missing.length} product(s)`);
    }

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('PURCHASE_ORDER', {
        factoryId: indent.factoryId, financialYearId, prefix: 'PO', transaction,
      });

      const totalAmountPaise = indent.lines.reduce(
        (sum, l) => sum + Math.round(Number(l.quantity) * rateByProduct.get(l.productId)),
        0
      );

      const po = await PurchaseOrder.create(
        {
          factoryId: indent.factoryId, poNumber: documentNumber, vendorPartyId,
          orderDate: orderDate || new Date().toISOString().slice(0, 10),
          expectedDate, totalAmountPaise, status: 'DRAFT',
        },
        { transaction }
      );

      await PurchaseOrderLine.bulkCreate(
        indent.lines.map((l) => ({
          purchaseOrderId: po.id, productId: l.productId,
          orderedQty: l.quantity, ratePaise: rateByProduct.get(l.productId),
        })),
        { transaction, individualHooks: true, validate: true }
      );

      await indent.update({ status: 'CONVERTED', purchaseOrderId: po.id }, { transaction });
      return po;
    });
  }

  static async cancel(id, reason) {
    const indent = await this.get(id);
    if (['CONVERTED', 'CANCELLED'].includes(indent.status)) {
      throw new ValidationError(`Cannot cancel an indent in ${indent.status} status`);
    }
    if (!reason) throw new ValidationError('A cancellation reason is required');
    await indent.update({ status: 'CANCELLED', rejectionReason: reason });
    return this.get(id);
  }

  /**
   * FR-M11-6 — three-way match: PO <-> GRN <-> Invoice.
   *
   * Compares, per product, what was ordered, what was accepted, and what the
   * vendor billed. Reports variances rather than blocking: a small price or
   * quantity difference is normal and needs a human decision, but it must be
   * visible before the invoice is paid.
   */
  static async threeWayMatch(purchaseInvoiceId) {
    const invoice = await PurchaseInvoice.findByPk(purchaseInvoiceId, {
      include: [
        {
          model: GoodsReceipt, as: 'goodsReceipt',
          include: [{ model: GoodsReceiptLine, as: 'lines', include: [{ model: Product, as: 'product' }] }],
        },
      ],
    });
    if (!invoice) throw new NotFoundError('Purchase invoice not found');

    const grn = invoice.goodsReceipt;
    const poId = grn?.purchaseOrderId;
    const poLines = poId ? await PurchaseOrderLine.findAll({ where: { purchaseOrderId: poId } }) : [];
    const poByProduct = new Map(poLines.map((l) => [l.productId, l]));

    const lines = [];
    let receiptValuePaise = 0;

    for (const grnLine of grn?.lines || []) {
      const poLine = poByProduct.get(grnLine.productId);
      const acceptedQty = Number(grnLine.receivedQty);
      const grnRate = Number(grnLine.ratePaise);
      const lineValue = Math.round(acceptedQty * grnRate);
      receiptValuePaise += lineValue;

      const orderedQty = poLine ? Number(poLine.orderedQty) : null;
      const poRate = poLine ? Number(poLine.ratePaise) : null;

      lines.push({
        productId: grnLine.productId,
        productName: grnLine.product?.name,
        orderedQty,
        acceptedQty,
        quantityVariance: orderedQty === null ? null : Number((acceptedQty - orderedQty).toFixed(4)),
        poRatePaise: poRate,
        grnRatePaise: grnRate,
        rateVariancePaise: poRate === null ? null : grnRate - poRate,
        lineValuePaise: lineValue,
      });
    }

    const invoiceValuePaise = Number(invoice.amountPaise);
    const valueVariancePaise = invoiceValuePaise - receiptValuePaise;

    const variances = [];
    if (!poId) variances.push({ type: 'NO_PURCHASE_ORDER', message: 'This receipt was made without a purchase order, so no order comparison is possible' });
    for (const line of lines) {
      if (line.quantityVariance !== null && Math.abs(line.quantityVariance) > 1e-6) {
        variances.push({
          type: 'QUANTITY', productId: line.productId,
          message: `${line.productName}: ordered ${line.orderedQty}, accepted ${line.acceptedQty}`,
        });
      }
      if (line.rateVariancePaise !== null && line.rateVariancePaise !== 0) {
        variances.push({
          type: 'RATE', productId: line.productId,
          message: `${line.productName}: the receipt rate differs from the ordered rate`,
        });
      }
    }
    if (valueVariancePaise !== 0) {
      variances.push({ type: 'INVOICE_VALUE', message: 'The vendor invoice total differs from the value of goods accepted' });
    }

    return {
      purchaseInvoiceId,
      purchaseOrderId: poId || null,
      goodsReceiptId: grn?.id || null,
      lines,
      receiptValuePaise,
      invoiceValuePaise,
      valueVariancePaise,
      matched: variances.length === 0,
      variances,
    };
  }
}

module.exports = { IndentService };
