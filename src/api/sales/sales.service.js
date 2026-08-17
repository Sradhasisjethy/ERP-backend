const { Op, fn, col } = require('sequelize');
const { sequelize } = require('../../config/database');
const { SalesOrder } = require('./salesOrder.model');
const { SalesOrderLine } = require('./salesOrderLine.model');
const { Party } = require('../parties/party.model');
const { Product } = require('../products/product.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { ReservationService } = require('../inventory/reservation.service');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../core/AppError');
const { addPaise } = require('../../utils/money');

// Orders in these statuses still hold a live soft reservation against ATP.
const ACTIVE_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'];

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

class SalesService {
  /**
   * BR-07/BR-11/BR-12 — Available-to-Promise.
   *
   * Returns the full breakdown the order screen must show (FR-M06-3), not just
   * a single number: total on hand, what's curing, what's already reserved,
   * what's in transit, and what is genuinely available to promise.
   *
   * Curing stock is reported separately and is NOT counted as available — the
   * mistake AC-3.1 exists to catch.
   */
  static async getAvailableToPromise(factoryId, productId, transaction) {
    await StockLedgerService.promoteEligibleLots(factoryId, transaction);
    return ReservationService.getAvailability(factoryId, productId, transaction);
  }

  // --- BR-13: credit control ---
  static async checkCreditLimit(customerPartyId, orderAmountPaise, { allowOverride = false, transaction } = {}) {
    const customer = await Party.findByPk(customerPartyId, { transaction });
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.creditAction === 'NONE' || !customer.creditLimitPaise) return { warning: false };

    const openTotal = await SalesOrder.sum('totalAmountPaise', {
      where: { customerPartyId, status: { [Op.in]: ACTIVE_ORDER_STATUSES } },
      transaction,
    });
    const projected = addPaise(openTotal || 0, orderAmountPaise);

    if (projected <= Number(customer.creditLimitPaise)) return { warning: false };

    // Note: this checks the credit *limit* only. The ageing-bucket half of
    // BR-13 ("or has overdue invoices beyond the configured ageing bucket")
    // needs AR/invoice data that doesn't exist until M20/M24 (Phase 2) — it's
    // a known gap to close then, not silently skipped.
    if (customer.creditAction === 'BLOCK' && !allowOverride) {
      throw new ForbiddenError(
        `Order blocked: customer credit limit is ${customer.creditLimitPaise} paise, projected outstanding would be ${projected} paise. Requires SALES_CREDIT_OVERRIDE to proceed.`
      );
    }

    return { warning: true, message: `Customer is over its credit limit (limit ${customer.creditLimitPaise} paise, projected ${projected} paise).` };
  }

  // --- Sales Orders ---
  static async listSalesOrders(page, limit, { factoryId, customerPartyId, status } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (customerPartyId) where.customerPartyId = customerPartyId;
    if (status) where.status = status;

    return SalesOrder.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Party, as: 'customer' }],
      order: [['orderDate', 'DESC']],
    });
  }

  static async getSalesOrder(id) {
    const order = await SalesOrder.findByPk(id, {
      include: [
        { model: Party, as: 'customer' },
        { model: SalesOrderLine, as: 'lines', include: [{ model: Product, as: 'product' }] },
      ],
    });
    if (!order) throw new NotFoundError('Sales order not found');
    return order;
  }

  static async createSalesOrder({ lines, allowCreditOverride, ...data }) {
    if (!lines || !lines.length) throw new ValidationError('A sales order requires at least one line');

    return sequelize.transaction(async (transaction) => {
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('SALES_ORDER', {
        factoryId: data.factoryId,
        financialYearId,
        prefix: 'SO',
        transaction,
      });

      const totalAmountPaise = addPaise(...lines.map((l) => l.orderedQty * l.ratePaise));

      const creditResult = await this.checkCreditLimit(data.customerPartyId, totalAmountPaise, { allowOverride: allowCreditOverride, transaction });

      const order = await SalesOrder.create({ ...data, orderNumber: documentNumber, totalAmountPaise }, { transaction });

      // BR-12 / AC-3.1: whatever available stock can't cover becomes a
      // production requirement on the line. Availability here excludes curing
      // and already-reserved stock, so the shortfall is what must actually be
      // made — not a number that quietly counts stock we can't ship.
      const linesWithRequirement = [];
      for (const line of lines) {
        const availability = await ReservationService.getAvailability(data.factoryId, line.productId, transaction);
        const productionRequired = Math.max(0, Number(line.orderedQty) - availability.available);
        linesWithRequirement.push({ ...line, salesOrderId: order.id, productionRequired });
      }

      await SalesOrderLine.bulkCreate(linesWithRequirement, { transaction, individualHooks: true, validate: true });

      const created = await this.getSalesOrder(order.id);
      return { order: created, creditWarning: creditResult.warning ? creditResult.message : null };
    });
  }

  /**
   * FR-M06-4 / FR-M07-2: confirmation is where stock is actually held. Each
   * line takes a FIFO hold against AVAILABLE lots; anything it can't cover
   * stays as productionRequired rather than blocking the order.
   */
  static async confirmSalesOrder(id) {
    return sequelize.transaction(async (transaction) => {
      const order = await this.getSalesOrder(id);
      if (order.status !== 'DRAFT') throw new ValidationError('Only a DRAFT sales order can be confirmed');

      await StockLedgerService.promoteEligibleLots(order.factoryId, transaction);

      for (const line of order.lines) {
        const outstanding = Number(line.orderedQty) - Number(line.dispatchedQty);
        if (outstanding <= 0) continue;
        const { shortfall } = await ReservationService.reserve({
          factoryId: order.factoryId,
          productId: line.productId,
          quantity: outstanding,
          referenceId: line.id,
          transaction,
        });
        await line.update({ productionRequired: shortfall }, { transaction });
      }

      await order.update({ status: 'CONFIRMED' }, { transaction });
      return this.getSalesOrder(id);
    });
  }

  /**
   * BR-16 / AC-3.3 / AC-3.4: cancellation requires a reason, releases every
   * lot hold the order was carrying (which returns the stock to available
   * without writing any ledger entry — nothing physically moved), and is
   * permanently logged. An order with any dispatch cannot be cancelled; it
   * must be short-closed instead.
   */
  static async cancelSalesOrder(id, reason) {
    return sequelize.transaction(async (transaction) => {
      const order = await this.getSalesOrder(id);
      if (['CANCELLED', 'SHORT_CLOSED', 'DISPATCHED'].includes(order.status)) {
        throw new ValidationError(`Cannot cancel a sales order in ${order.status} status`);
      }
      if (order.lines.some((l) => Number(l.dispatchedQty) > 0)) {
        throw new ValidationError('This order has dispatches against it — it must be short-closed, not cancelled');
      }
      if (!reason) throw new ValidationError('A cancellation reason is required');

      await ReservationService.releaseMany({
        referenceIds: order.lines.map((l) => l.id),
        reason: `Order cancelled: ${reason}`,
        transaction,
      });

      await order.update({ status: 'CANCELLED', cancelReason: reason, cancelledAt: new Date() }, { transaction });
      return this.getSalesOrder(id);
    });
  }

  /**
   * FR-M06-11 / AC-3.3: closes the undelivered balance, releasing the holds on
   * the remaining quantity so that stock becomes available to other customers.
   */
  static async shortCloseSalesOrder(id, reason) {
    return sequelize.transaction(async (transaction) => {
      const order = await this.getSalesOrder(id);
      if (['CANCELLED', 'SHORT_CLOSED'].includes(order.status)) {
        throw new ValidationError(`Cannot short-close a sales order in ${order.status} status`);
      }
      if (!order.lines.some((l) => Number(l.dispatchedQty) > 0)) {
        throw new ValidationError('An order with no dispatch should be cancelled, not short-closed');
      }
      if (!reason) throw new ValidationError('A short-close reason is required');

      await ReservationService.releaseMany({
        referenceIds: order.lines.map((l) => l.id),
        reason: `Order short-closed: ${reason}`,
        transaction,
      });

      await order.update({ status: 'SHORT_CLOSED', shortCloseReason: reason, shortClosedAt: new Date() }, { transaction });
      return this.getSalesOrder(id);
    });
  }
}

module.exports = { SalesService, ACTIVE_ORDER_STATUSES };
