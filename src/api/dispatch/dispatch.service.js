const { sequelize } = require('../../config/database');
const { searchWhere } = require('../../utils/pagination');
const { DeliveryChallan } = require('./deliveryChallan.model');
const { DeliveryChallanLine } = require('./deliveryChallanLine.model');
const { SalesOrder } = require('../sales/salesOrder.model');
const { SalesOrderLine } = require('../sales/salesOrderLine.model');
const { Product } = require('../products/product.model');
const { Party } = require('../parties/party.model');
const { Factory } = require('../factory/factory.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { StockLedgerService } = require('../inventory/stockLedger.service');
const { StockLedgerEntry } = require('../inventory/stockLedgerEntry.model');
const { ReservationService } = require('../inventory/reservation.service');
const { NotFoundError, ValidationError } = require('../../core/AppError');

const ACTIVE_ORDER_STATUSES = ['CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED'];

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

const recomputeSalesOrderStatus = async (salesOrder, transaction) => {
  const lines = await SalesOrderLine.findAll({ where: { salesOrderId: salesOrder.id }, transaction });
  const fullyDispatched = lines.every((l) => Number(l.dispatchedQty) >= Number(l.orderedQty));
  const anyDispatched = lines.some((l) => Number(l.dispatchedQty) > 0);

  let status = salesOrder.status;
  if (fullyDispatched) status = 'DISPATCHED';
  else if (anyDispatched) status = 'PARTIALLY_DISPATCHED';
  else if (['PARTIALLY_DISPATCHED', 'DISPATCHED'].includes(salesOrder.status)) status = 'CONFIRMED'; // dispatch was reversed back to zero

  if (status !== salesOrder.status) await salesOrder.update({ status }, { transaction });
};

class DispatchService {
  static async listChallans(page, limit, { factoryId, salesOrderId, status, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (factoryId) where.factoryId = factoryId;
    if (salesOrderId) where.salesOrderId = salesOrderId;
    if (status) where.status = status;

    if (search) Object.assign(where, searchWhere(search, ['challanNumber', 'vehicleNumber', 'driverName']));
    return DeliveryChallan.findAndCountAll({
      where,
      limit,
      offset,
      include: [
        { model: SalesOrder, as: 'salesOrder', include: [{ model: Party, as: 'customer' }] },
        { model: DeliveryChallanLine, as: 'lines', include: [{ model: Product, as: 'product' }] },
      ],
      order: [['dispatchDate', 'DESC']],
    });
  }

  static async getChallan(id) {
    const challan = await DeliveryChallan.findByPk(id, {
      include: [
        { model: SalesOrder, as: 'salesOrder', include: [{ model: Party, as: 'customer' }] },
        { model: DeliveryChallanLine, as: 'lines', include: [{ model: Product, as: 'product' }] },
      ],
    });
    if (!challan) throw new NotFoundError('Delivery challan not found');
    return challan;
  }

  // BR-01..BR-05 (FIFO/lot consumption via StockLedgerService), BR-03 (lot
  // override), BR-14 (dispatch tolerance), BR-33 (immutable once posted).
  static async createChallan({ salesOrderId, lines, ...data }) {
    if (!lines || !lines.length) throw new ValidationError('A delivery challan requires at least one line');

    return sequelize.transaction(async (transaction) => {
      const salesOrder = await SalesOrder.findByPk(salesOrderId, {
        include: [{ model: SalesOrderLine, as: 'lines' }],
        transaction,
      });
      if (!salesOrder) throw new NotFoundError('Sales order not found');
      if (!ACTIVE_ORDER_STATUSES.includes(salesOrder.status)) {
        throw new ValidationError(`Cannot dispatch against a sales order in ${salesOrder.status} status`);
      }

      const factory = await Factory.findByPk(salesOrder.factoryId, { transaction });
      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('DELIVERY_CHALLAN', {
        factoryId: salesOrder.factoryId,
        financialYearId,
        prefix: 'DC',
        transaction,
      });

      const challan = await DeliveryChallan.create(
        { ...data, factoryId: salesOrder.factoryId, salesOrderId, challanNumber: documentNumber },
        { transaction }
      );

      const soLinesById = Object.fromEntries(salesOrder.lines.map((l) => [l.id, l]));
      const tolerance = Number(factory.dispatchTolerancePercent) / 100;

      for (const line of lines) {
        const soLine = soLinesById[line.salesOrderLineId];
        if (!soLine) throw new NotFoundError(`Sales order line ${line.salesOrderLineId} not found on this order`);

        const maxAllowed = Number(soLine.orderedQty) * (1 + tolerance);
        const projectedDispatched = Number(soLine.dispatchedQty) + Number(line.dispatchedQty);
        // BR-14: dispatch quantity may not exceed ordered quantity plus tolerance.
        if (projectedDispatched > maxAllowed) {
          throw new ValidationError(
            `Dispatch quantity for ${soLine.productId} exceeds ordered quantity + tolerance (max ${maxAllowed}, would be ${projectedDispatched})`
          );
        }

        await StockLedgerService.consumeFifo({
          factoryId: salesOrder.factoryId,
          productId: soLine.productId,
          quantity: line.dispatchedQty,
          movementType: 'SALE_OUT',
          referenceType: 'DeliveryChallan',
          referenceId: challan.id,
          overrideLotId: line.overrideLotId,
          overrideReason: line.overrideLotReason,
          transaction,
        });

        // FR-M07-3: the hold this line was carrying becomes a real issue.
        // Marked CONSUMED rather than RELEASED so reporting can distinguish
        // "the customer took it" from "we gave up on the order".
        await ReservationService.consume({
          referenceId: soLine.id,
          quantity: line.dispatchedQty,
          transaction,
        });

        await DeliveryChallanLine.create(
          { deliveryChallanId: challan.id, salesOrderLineId: soLine.id, productId: soLine.productId, dispatchedQty: line.dispatchedQty },
          { transaction }
        );

        await soLine.update({ dispatchedQty: projectedDispatched }, { transaction });
      }

      await recomputeSalesOrderStatus(salesOrder, transaction);

      return this.getChallan(challan.id);
    });
  }

  // BR-33: cancellation preserves the record and number — never deletes.
  static async cancelChallan(id, reason) {
    const challan = await this.getChallan(id);
    if (challan.status !== 'DISPATCHED') throw new ValidationError(`Only a DISPATCHED challan can be cancelled (current status: ${challan.status})`);
    if (challan.invoiced) throw new ValidationError('Cannot cancel a challan that has already been invoiced');
    if (!reason) throw new ValidationError('A cancellation reason is required');

    return sequelize.transaction(async (transaction) => {
      const entries = await StockLedgerEntry.findAll({
        where: { referenceType: 'DeliveryChallan', referenceId: challan.id, movementType: 'SALE_OUT' },
        transaction,
      });
      for (const entry of entries) {
        await StockLedgerService.reverseEntry(entry.id, reason, transaction);
      }

      const salesOrder = await SalesOrder.findByPk(challan.salesOrderId, { transaction });
      for (const line of challan.lines) {
        const soLine = await SalesOrderLine.findByPk(line.salesOrderLineId, { transaction });
        await soLine.update({ dispatchedQty: Math.max(0, Number(soLine.dispatchedQty) - Number(line.dispatchedQty)) }, { transaction });

        // FR-M15-9: the stock came back, so re-hold it for this order rather
        // than releasing it to the open pool — the order is still live.
        if (!['CANCELLED', 'SHORT_CLOSED'].includes(salesOrder.status)) {
          await ReservationService.reserve({
            factoryId: salesOrder.factoryId,
            productId: soLine.productId,
            quantity: line.dispatchedQty,
            referenceId: soLine.id,
            transaction,
          });
        }
      }
      await recomputeSalesOrderStatus(salesOrder, transaction);

      await challan.update({ status: 'CANCELLED', cancelReason: reason }, { transaction });
      return this.getChallan(id);
    });
  }
}

module.exports = { DispatchService };
