const { Op, fn, col, literal } = require('sequelize');
const { StockLot } = require('./stockLot.model');
const { StockReservation } = require('./stockReservation.model');
const { StockTransfer } = require('../transfer/stockTransfer.model');
const { StockTransferLine } = require('../transfer/stockTransferLine.model');
const { ValidationError, NotFoundError } = require('../../core/AppError');

/**
 * M07 — stock reservation and the availability arithmetic every sales screen
 * depends on. Reservations never touch the stock ledger (AC-3.4); they only
 * reduce what may be promised to the next customer.
 */
class ReservationService {
  /**
   * FR-M07-1: available = on_hand - reserved - curing - in_transit.
   *
   * The distinction that matters (and the one AC-3.1 exists to catch): curing
   * stock is NOT available stock. A 100-unit order against 30 available + 25
   * curing has a shortfall of 70, not 45.
   */
  static async getAvailability(factoryId, productId, transaction) {
    const lots = await StockLot.findAll({
      where: { factoryId, productId, qtyAvailable: { [Op.gt]: 0 } },
      transaction,
    });

    const onHand = lots.reduce((sum, l) => sum + Number(l.qtyAvailable), 0);
    const curing = lots.filter((l) => l.status === 'CURING').reduce((sum, l) => sum + Number(l.qtyAvailable), 0);
    const withContractor = lots
      .filter((l) => l.status === 'WITH_CONTRACTOR')
      .reduce((sum, l) => sum + Number(l.qtyAvailable), 0);

    const reservedRow = await StockReservation.findOne({
      attributes: [[fn('COALESCE', fn('SUM', col('quantity')), 0), 'total']],
      where: { factoryId, productId, status: 'ACTIVE' },
      transaction,
      raw: true,
    });
    const reserved = Number(reservedRow?.total || 0);

    // Stock dispatched from this factory but not yet received elsewhere belongs
    // to neither factory's available balance (AC-5.6).
    const inTransitRow = await StockTransferLine.findOne({
      attributes: [[fn('COALESCE', fn('SUM', col('StockTransferLine.quantity')), 0), 'total']],
      include: [{
        model: StockTransfer, as: 'stockTransfer', attributes: [],
        where: { fromFactoryId: factoryId, status: 'IN_TRANSIT' }, required: true,
      }],
      where: { productId },
      transaction,
      raw: true,
    });
    const inTransit = Number(inTransitRow?.total || 0);

    const sellable = lots
      .filter((l) => l.status === 'AVAILABLE')
      .reduce((sum, l) => sum + Number(l.qtyAvailable), 0);

    return {
      onHand,
      curing,
      withContractor,
      reserved,
      inTransit,
      available: Math.max(0, sellable - reserved),
    };
  }

  /**
   * FR-M07-2: holds `quantity` against AVAILABLE lots in FIFO order.
   * Curing lots are never reserved — they can't be promised.
   * Returns the per-lot holds actually created.
   */
  static async reserve({ factoryId, productId, quantity, referenceType = 'SalesOrderLine', referenceId, transaction }) {
    const wanted = Number(quantity);
    if (wanted <= 0) throw new ValidationError('Reservation quantity must be positive');

    const lots = await StockLot.findAll({
      where: { factoryId, productId, status: 'AVAILABLE', qtyAvailable: { [Op.gt]: 0 } },
      order: [['originDate', 'ASC'], ['createdAt', 'ASC']],
      transaction,
      lock: transaction ? transaction.LOCK.UPDATE : undefined,
    });

    // Existing holds are per-lot, so subtract them per-lot rather than in
    // aggregate — otherwise the same physical units get promised twice.
    const heldRows = await StockReservation.findAll({
      attributes: ['lotId', [fn('COALESCE', fn('SUM', col('quantity')), 0), 'held']],
      where: { factoryId, productId, status: 'ACTIVE' },
      group: ['lotId'],
      transaction,
      raw: true,
    });
    const heldByLot = new Map(heldRows.map((r) => [r.lotId, Number(r.held)]));

    const created = [];
    let remaining = wanted;

    for (const lot of lots) {
      if (remaining <= 0) break;
      const free = Number(lot.qtyAvailable) - (heldByLot.get(lot.id) || 0);
      if (free <= 0) continue;
      const take = Math.min(free, remaining);
      const reservation = await StockReservation.create(
        { factoryId, productId, lotId: lot.id, referenceType, referenceId, quantity: take },
        { transaction }
      );
      created.push({ reservationId: reservation.id, lotId: lot.id, quantity: take });
      remaining -= take;
    }

    // A partial hold is intentionally allowed and reported: the order is still
    // valid, the balance simply becomes a production requirement (BR-12).
    return { reserved: wanted - remaining, shortfall: remaining, holds: created };
  }

  /** FR-M07-3: releases every active hold for a reference (cancel / short-close). */
  static async release({ referenceType = 'SalesOrderLine', referenceId, reason, transaction }) {
    const [count] = await StockReservation.update(
      { status: 'RELEASED', releasedReason: reason || null, releasedAt: new Date() },
      { where: { referenceType, referenceId, status: 'ACTIVE' }, transaction }
    );
    return count;
  }

  /** Releases holds for many references at once (a whole order's lines). */
  static async releaseMany({ referenceType = 'SalesOrderLine', referenceIds, reason, transaction }) {
    if (!referenceIds?.length) return 0;
    const [count] = await StockReservation.update(
      { status: 'RELEASED', releasedReason: reason || null, releasedAt: new Date() },
      { where: { referenceType, referenceId: { [Op.in]: referenceIds }, status: 'ACTIVE' }, transaction }
    );
    return count;
  }

  /**
   * Dispatch converts a hold into a real issue: the reservation is marked
   * CONSUMED (not RELEASED) so reporting can tell "the customer took it" from
   * "we gave up on it", and the actual stock movement is posted separately by
   * StockLedgerService.
   */
  static async consume({ referenceType = 'SalesOrderLine', referenceId, quantity, transaction }) {
    const active = await StockReservation.findAll({
      where: { referenceType, referenceId, status: 'ACTIVE' },
      order: [['createdAt', 'ASC']],
      transaction,
    });

    let remaining = Number(quantity);
    for (const reservation of active) {
      if (remaining <= 0) break;
      const qty = Number(reservation.quantity);
      if (qty <= remaining) {
        await reservation.update({ status: 'CONSUMED' }, { transaction });
        remaining -= qty;
      } else {
        // Partial dispatch: consume part of this hold and keep the rest active.
        await reservation.update({ quantity: qty - remaining }, { transaction });
        await StockReservation.create(
          {
            factoryId: reservation.factoryId, productId: reservation.productId, lotId: reservation.lotId,
            referenceType, referenceId, quantity: remaining, status: 'CONSUMED',
          },
          { transaction }
        );
        remaining = 0;
      }
    }
    return Number(quantity) - remaining;
  }

  static async listByReference(referenceType, referenceId) {
    return StockReservation.findAll({
      where: { referenceType, referenceId },
      include: [{ model: StockLot, as: 'lot' }],
      order: [['createdAt', 'ASC']],
    });
  }

  /** FR-M07-4: holds older than `days` that are still active. */
  static async listStale(days = 30) {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    return StockReservation.findAll({
      where: { status: 'ACTIVE', createdAt: { [Op.lte]: cutoff } },
      include: [{ model: StockLot, as: 'lot' }],
      order: [['createdAt', 'ASC']],
    });
  }
}

module.exports = { ReservationService };
