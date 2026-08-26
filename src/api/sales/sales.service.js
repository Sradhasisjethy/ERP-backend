const { Op, fn, col } = require('sequelize');
const { sequelize } = require('../../config/database');
const { SalesOrder } = require('./salesOrder.model');
const { SalesOrderLine } = require('./salesOrderLine.model');
const { Party } = require('../parties/party.model');
const { Product } = require('../products/product.model');
const { assertUsableParty, assertUsableProducts } = require('../../core/masterGuards');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { ReservationService } = require('../inventory/reservation.service');
const { NotFoundError, ValidationError, ForbiddenError } = require('../../core/AppError');
const { addPaise } = require('../../utils/money');
const { toOrder } = require('../../utils/pagination');
const { NotificationsService } = require('../notifications/notifications.service');

// Orders in these statuses still hold a live soft reservation against ATP.
const ACTIVE_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'];

const SORTABLE = ['orderNumber', 'orderDate', 'expectedDeliveryDate', 'status', 'totalAmountPaise', 'createdAt'];

/**
 * The order lifecycle, in one place.
 *
 * Before this, each transition was guarded by an ad-hoc `if` in whichever
 * service happened to perform it — sales.service for confirm/cancel/
 * short-close, dispatch.service for the dispatch-driven ones. Three of the
 * seven enum values could not be reached at all, and nothing described which
 * moves were legal, so every new action had to re-derive the rules.
 *
 * `IN_PRODUCTION` was the clearest symptom: it is in the enum, in
 * ACTIVE_ORDER_STATUSES and in the dashboard's open-order filter, but nothing
 * ever set it — an order whose stock had to be manufactured looked identical
 * to one shipping from stock.
 */
const ORDER_TRANSITIONS = Object.freeze({
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['IN_PRODUCTION', 'PARTIALLY_DISPATCHED', 'DISPATCHED', 'SHORT_CLOSED', 'CANCELLED'],
  IN_PRODUCTION: ['CONFIRMED', 'PARTIALLY_DISPATCHED', 'DISPATCHED', 'SHORT_CLOSED', 'CANCELLED'],
  PARTIALLY_DISPATCHED: ['CONFIRMED', 'DISPATCHED', 'SHORT_CLOSED'],
  DISPATCHED: ['PARTIALLY_DISPATCHED', 'CONFIRMED', 'SHORT_CLOSED'],
  SHORT_CLOSED: [],
  CANCELLED: [],
});

/** Terminal states can never move again — enforced centrally, not per action. */
const assertTransition = (from, to) => {
  if (from === to) return;
  if (!(ORDER_TRANSITIONS[from] || []).includes(to)) {
    throw new ValidationError(`A sales order cannot move from ${from} to ${to}`);
  }
};

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
  static async checkCreditLimit(customerPartyId, orderAmountPaise, { allowOverride = false, excludeOrderId, transaction } = {}) {
    const customer = await Party.findByPk(customerPartyId, { transaction });
    if (!customer) throw new NotFoundError('Customer not found');
    if (customer.creditAction === 'NONE' || !customer.creditLimitPaise) return { warning: false };

    const openTotal = await SalesOrder.sum('totalAmountPaise', {
      // An edit re-checks the whole order, so its own current total must not be
      // counted alongside the new one.
      where: {
        customerPartyId,
        status: { [Op.in]: ACTIVE_ORDER_STATUSES },
        ...(excludeOrderId ? { id: { [Op.ne]: excludeOrderId } } : {}),
      },
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
  /**
   * `baseWhere` carries the caller's BR-29 factory restriction, already
   * resolved by the controller. It is a parameter rather than something this
   * service works out for itself because the restriction depends on `req`,
   * which the service layer deliberately never sees.
   */
  static async listSalesOrders(page, limit, { customerPartyId, status, search, sortBy, sortDir, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (customerPartyId) where.customerPartyId = customerPartyId;
    if (status) where.status = status;

    // Searching the customer's name as well as the order number means the
    // include has to be able to filter, so it is built here rather than being
    // a fixed association.
    const customerInclude = { model: Party, as: 'customer' };
    if (search) {
      where[Op.or] = [
        { orderNumber: { [Op.iLike]: `%${search}%` } },
        { poReferenceNumber: { [Op.iLike]: `%${search}%` } },
        { '$customer.name$': { [Op.iLike]: `%${search}%` } },
      ];
    }

    return SalesOrder.findAndCountAll({
      where,
      limit,
      offset,
      include: [customerInclude],
      order: toOrder(sortBy, sortDir, SORTABLE, [['orderDate', 'DESC'], ['orderNumber', 'DESC']]),
      // `$customer.name$` in the where forces a single query; without this
      // Sequelize splits the include into a second query and the reference
      // cannot resolve.
      subQuery: false,
      distinct: true,
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
    this.assertDatesCoherent(data);

    const result = await sequelize.transaction(async (transaction) => {
      await this.validateLines(lines, transaction);
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('SALES_ORDER', {
        factoryId: data.factoryId,
        financialYearId,
        prefix: 'SO',
        transaction,
      });

      // A foreign key proves customerPartyId is *a* party; it cannot prove the
      // party is a customer rather than a vendor or a labourer, nor that it is
      // still active. Both are business rules, so they are checked here — an
      // order raised against a vendor would otherwise land in receivables and
      // corrupt that party's ledger from the first document.
      await assertUsableParty(Party, data.customerPartyId, 'CUSTOMER', transaction);

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
      return {
        order: created,
        creditWarning: creditResult.warning ? creditResult.message : null,
        breachedCustomerId: creditResult.warning ? data.customerPartyId : null,
      };
    });

    // Raised AFTER the transaction commits, never inside it.
    //
    // CREDIT_LIMIT_BREACH is one of several alert types that describe a
    // transactional condition but were only ever raised by the overnight batch
    // — so an order accepted over a customer's credit limit went unreported
    // until the morning after it shipped.
    //
    // The first attempt at this raised the alert from inside checkCreditLimit,
    // which runs within the order's transaction. Sequelize's CLS injects that
    // transaction into the notification insert, so a failed insert poisons the
    // whole transaction at the Postgres level — the `.catch()` swallowed the
    // notification error while every later statement failed with "current
    // transaction is aborted", and order creation returned 500. An alert about
    // a document must never be able to prevent that document from existing.
    if (result.breachedCustomerId) {
      await NotificationsService.raise({
        type: 'CREDIT_LIMIT_BREACH',
        severity: 'HIGH',
        title: 'Order accepted over a customer credit limit',
        message: 'A sales order was accepted that takes this customer past their agreed credit limit.',
        factoryId: data.factoryId,
        entityType: 'Party',
        entityId: result.breachedCustomerId,
        metadata: { salesOrderId: result.order.id },
        dedupeKey: `CREDIT_LIMIT_BREACH:${result.breachedCustomerId}`,
      }).catch(() => {});
    }

    return { order: result.order, creditWarning: result.creditWarning };
  }

  /**
   * Line-level rules shared by create and edit.
   *
   * The duplicate-product check matters more than it looks: two lines for the
   * same product each compute `productionRequired` against the *same*
   * availability snapshot, so a 60 + 60 order against 100 units books 0
   * production requirement on both lines instead of 20. Reservation, dispatch
   * tolerance and the production sheet all inherit that error.
   */
  static async validateLines(lines, transaction) {
    if (!lines || !lines.length) throw new ValidationError('A sales order requires at least one line');

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

  static assertDatesCoherent({ orderDate, expectedDeliveryDate }) {
    if (orderDate && expectedDeliveryDate && expectedDeliveryDate < orderDate) {
      throw new ValidationError('Expected delivery date cannot be earlier than the order date');
    }
  }

  /**
   * FR-M06-2: a DRAFT order is still being negotiated and must be correctable.
   *
   * Only DRAFT: once an order is CONFIRMED it holds stock reservations and may
   * already have dispatches against it, so changing its lines would silently
   * invalidate both. The supported route from there is cancel (nothing
   * dispatched) or short-close (something dispatched).
   *
   * Replacing the lines wholesale rather than diffing them is deliberate — a
   * DRAFT line has no dispatch history or reservation to preserve, so a diff
   * would add reconciliation logic with nothing to reconcile.
   */
  static async updateSalesOrder(id, { lines, ...data }) {
    return sequelize.transaction(async (transaction) => {
      const order = await SalesOrder.findByPk(id, { transaction });
      if (!order) throw new NotFoundError('Sales order not found');
      if (order.status !== 'DRAFT') {
        throw new ValidationError(
          `Only a DRAFT sales order can be edited (this one is ${order.status}). Cancel it, or short-close it if it has dispatches.`
        );
      }

      this.assertDatesCoherent({
        orderDate: data.orderDate || order.orderDate,
        expectedDeliveryDate: data.expectedDeliveryDate !== undefined ? data.expectedDeliveryDate : order.expectedDeliveryDate,
      });

      // The customer may be changed on a draft, but only to another usable one.
      if (data.customerPartyId && data.customerPartyId !== order.customerPartyId) {
        await assertUsableParty(Party, data.customerPartyId, 'CUSTOMER', transaction);
      }
      // factoryId is fixed at creation: the order number was allocated from
      // that factory's series and its stock availability was computed there.
      delete data.factoryId;

      let totalAmountPaise = Number(order.totalAmountPaise);
      if (lines) {
        await this.validateLines(lines, transaction);
        totalAmountPaise = addPaise(...lines.map((l) => l.orderedQty * l.ratePaise));
      }

      await this.checkCreditLimit(data.customerPartyId || order.customerPartyId, totalAmountPaise, {
        allowOverride: data.allowCreditOverride,
        excludeOrderId: order.id,
        transaction,
      });

      await order.update({ ...data, totalAmountPaise }, { transaction });

      if (lines) {
        await SalesOrderLine.destroy({ where: { salesOrderId: id }, transaction });
        const rebuilt = [];
        for (const line of lines) {
          const availability = await ReservationService.getAvailability(order.factoryId, line.productId, transaction);
          rebuilt.push({
            ...line,
            salesOrderId: id,
            productionRequired: Math.max(0, Number(line.orderedQty) - availability.available),
          });
        }
        await SalesOrderLine.bulkCreate(rebuilt, { transaction, individualHooks: true, validate: true });
      }

      return this.getSalesOrder(id);
    });
  }

  /**
   * FR-M06-4: flags a confirmed order as waiting on manufacture.
   *
   * Only meaningful when some line could not be covered from stock, which is
   * exactly what `productionRequired` records at confirmation. Without this the
   * status existed but was unreachable, so "waiting for production" and
   * "ready to ship" were indistinguishable on the order list and the dashboard.
   */
  static async markInProduction(id) {
    return sequelize.transaction(async (transaction) => {
      const order = await this.getSalesOrder(id);
      assertTransition(order.status, 'IN_PRODUCTION');

      const lines = await SalesOrderLine.findAll({ where: { salesOrderId: id }, transaction });
      if (!lines.some((l) => Number(l.productionRequired) > 0)) {
        throw new ValidationError('This order is fully covered from stock — there is nothing to produce for it');
      }

      await order.update({ status: 'IN_PRODUCTION' }, { transaction });
      return this.getSalesOrder(id);
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
      if (order.status !== 'DRAFT') throw new ValidationError(`Only a DRAFT sales order can be confirmed (this one is ${order.status})`);
      assertTransition(order.status, 'CONFIRMED');

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
      // Checked before the generic transition guard so the caller gets the
      // actionable instruction ("short-close it") rather than a bare
      // "cannot move from X to Y".
      if (order.lines.some((l) => Number(l.dispatchedQty) > 0)) {
        throw new ValidationError('This order has dispatches against it — it must be short-closed, not cancelled');
      }
      assertTransition(order.status, 'CANCELLED');
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
      assertTransition(order.status, 'SHORT_CLOSED');
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

module.exports = { SalesService, ACTIVE_ORDER_STATUSES, ORDER_TRANSITIONS, assertTransition };
