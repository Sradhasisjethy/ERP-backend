const { Op, literal } = require('sequelize');
const { searchWhere } = require('../../utils/pagination');
const { sequelize } = require('../../config/database');
const { StockLot } = require('./stockLot.model');
const { StockLedgerEntry } = require('./stockLedgerEntry.model');
const { Product } = require('../products/product.model');
const { Factory } = require('../factory/factory.model');
const { ValidationError, NotFoundError } = require('../../core/AppError');
const { toOrder } = require('../../utils/pagination');
const { getUserId } = require('../../core/tenantContext');

const LOT_SORTABLE = ['lotNumber', 'originDate', 'status', 'qtyAvailable', 'createdAt'];
const ENTRY_SORTABLE = ['movementType', 'direction', 'quantity', 'createdAt'];
const { logger } = require('../../utils/logger');

class StockLedgerService {
  /**
   * Lazily promotes CURING lots to AVAILABLE once their curing period has
   * elapsed (BR-08). There's no job scheduler in this codebase, so instead of
   * a cron this runs as a cheap bulk UPDATE at the top of every read/consume
   * path below — from the caller's perspective a lot "just becomes available"
   * the moment anyone looks at stock for that factory, which is what BR-08
   * actually requires (no dispatch/report should ever see a stale CURING lot
   * that has already finished curing).
   */
  static async promoteEligibleLots(factoryId, transaction) {
    await StockLot.update(
      { status: 'AVAILABLE' },
      {
        where: {
          factoryId,
          status: 'CURING',
          [Op.and]: [literal(`"originDate" + ("curingDays" || ' days')::interval <= NOW()`)],
        },
        transaction,
      }
    );
  }

  static async createLot({ factoryId, productId, lotNumber, originType, originId, originDate, curingDaysOverride, quantity, statusOverride, heldByPartyId, transaction }) {
    const product = await Product.findByPk(productId, { transaction });
    if (!product) throw new NotFoundError('Product not found');

    const curingDays = curingDaysOverride ?? product.curingDays ?? 0;

    // A lot's curing clock is anchored to originDate, not to "now" — this
    // matters when originDate is in the past (e.g. a transferred lot carries
    // over the source lot's original production date, per BR-02's "own
    // origin date"). A lot whose curing period already elapsed must start
    // life AVAILABLE, not CURING, even though curingDays > 0.
    // statusOverride bypasses this for statuses outside the curing lifecycle
    // entirely (WITH_CONTRACTOR) — see contractor.service.js.
    const curingEndsAt = new Date(originDate);
    curingEndsAt.setDate(curingEndsAt.getDate() + curingDays);
    const status = statusOverride || (curingDays > 0 && curingEndsAt > new Date() ? 'CURING' : 'AVAILABLE');

    // qtyAvailable starts at 0, not `quantity` — postEntry() is the only
    // function allowed to move that number, and every caller here follows
    // createLot() with a postEntry() IN call for the same quantity. Seeding
    // qtyAvailable here too would double-count it the moment that IN entry posts.
    return StockLot.create(
      {
        factoryId,
        productId,
        lotNumber,
        originType,
        originId,
        originDate,
        curingDays,
        status,
        heldByPartyId: heldByPartyId || null,
        qtyOriginal: quantity,
        qtyAvailable: 0,
      },
      { transaction }
    );
  }

  /**
   * Posts a single stock movement (BR-01) and applies its effect to the lot's
   * running qtyAvailable in the same transaction. This is the only function
   * in the codebase allowed to write StockLedgerEntry or mutate
   * StockLot.qtyAvailable — every other module (purchasing, transfer,
   * production, dispatch) goes through here.
   */
  static async postEntry({ factoryId, productId, lotId, movementType, direction, quantity, referenceType, referenceId, notes, transaction }) {
    if (Number(quantity) <= 0) {
      throw new ValidationError('Stock movement quantity must be positive');
    }
    // AP-1: a stock movement must be written in the same transaction as the
    // business document that caused it. Without one the row lock below is
    // meaningless (concurrent dispatches could oversell), so refuse loudly
    // rather than failing later with an opaque error.
    if (!transaction) {
      throw new Error('StockLedgerService.postEntry requires a transaction');
    }

    const lot = await StockLot.findOne({ where: { id: lotId, factoryId }, transaction, lock: transaction.LOCK.UPDATE });
    if (!lot) throw new NotFoundError('Stock lot not found for this factory');

    let isNegativeStockEvent = false;

    if (direction === 'OUT') {
      const resultingQty = Number(lot.qtyAvailable) - Number(quantity);
      if (resultingQty < 0) {
        const factory = await Factory.findByPk(factoryId, { transaction });
        if (!factory || !factory.allowNegativeStock) {
          throw new ValidationError(
            `Insufficient stock in lot ${lot.lotNumber}: available ${lot.qtyAvailable}, requested ${quantity}`
          );
        }
        isNegativeStockEvent = true;
        logger.warn({ message: 'Negative stock event', lotId, factoryId, productId, resultingQty });
      }
      await lot.update(
        { qtyAvailable: resultingQty, status: resultingQty <= 0 && lot.status === 'AVAILABLE' ? 'CONSUMED' : lot.status },
        { transaction }
      );
    } else {
      const resultingQty = Number(lot.qtyAvailable) + Number(quantity);
      // A lot that was fully drawn down is marked CONSUMED by the OUT branch
      // above. When stock comes back — a cancelled dispatch, a sales return,
      // a reversed receipt — the quantity was restored but the status was not,
      // leaving a lot holding stock that `status: 'AVAILABLE'` queries cannot
      // see. The ledger and the raw lot quantity said the stock was there;
      // availability, reservation and the balance endpoint said it was not.
      //
      // Only CONSUMED is reversed. CURING, WITH_CONTRACTOR and IN_TRANSIT are
      // lifecycle states an inbound movement must not silently overwrite.
      const status = lot.status === 'CONSUMED' && resultingQty > 0 ? 'AVAILABLE' : lot.status;
      await lot.update({ qtyAvailable: resultingQty, status }, { transaction });
    }

    return StockLedgerEntry.create(
      {
        factoryId,
        productId,
        lotId,
        movementType,
        direction,
        quantity,
        referenceType,
        referenceId,
        isNegativeStockEvent,
        notes,
        createdBy: getUserId() || null,
      },
      { transaction }
    );
  }

  /**
   * Reverses a previously posted entry (BR-05: corrections are a reversing
   * entry that references the original — the original is never touched).
   */
  static async reverseEntry(entryId, reason, transaction) {
    const original = await StockLedgerEntry.findByPk(entryId, { transaction });
    if (!original) throw new NotFoundError('Stock ledger entry not found');

    const reversal = await this.postEntry({
      factoryId: original.factoryId,
      productId: original.productId,
      lotId: original.lotId,
      movementType: 'REVERSAL',
      direction: original.direction === 'IN' ? 'OUT' : 'IN',
      quantity: original.quantity,
      referenceType: original.referenceType,
      referenceId: original.referenceId,
      notes: reason,
      transaction,
    });

    await StockLedgerEntry.update({ reversalOfEntryId: original.id }, { where: { id: reversal.id }, transaction });
    return reversal;
  }

  /**
   * Consumes stock FIFO by lot (BR-03) for a product at a factory, splitting
   * across multiple lots if one isn't enough. Pass `overrideLotId` to consume
   * a specific lot instead — the caller is responsible for checking the
   * override permission and always supplying `overrideReason`, which is
   * recorded on the ledger entry.
   * Returns the list of { lotId, quantity } actually consumed.
   */
  static async consumeFifo({ factoryId, productId, quantity, movementType, referenceType, referenceId, overrideLotId, overrideReason, sourceStatus = 'AVAILABLE', heldByPartyId, transaction }) {
    await this.promoteEligibleLots(factoryId, transaction);

    if (overrideLotId) {
      if (!overrideReason) throw new ValidationError('overrideReason is required when selecting a specific lot');
      await this.postEntry({
        factoryId, productId, lotId: overrideLotId, movementType, direction: 'OUT', quantity,
        referenceType, referenceId, notes: `Lot override: ${overrideReason}`, transaction,
      });
      return [{ lotId: overrideLotId, quantity }];
    }

    const where = { factoryId, productId, status: sourceStatus, qtyAvailable: { [Op.gt]: 0 } };
    if (heldByPartyId) where.heldByPartyId = heldByPartyId;

    const lots = await StockLot.findAll({
      where,
      order: [['originDate', 'ASC'], ['createdAt', 'ASC']],
      transaction,
      lock: transaction.LOCK.UPDATE,
    });

    const totalAvailable = lots.reduce((sum, lot) => sum + Number(lot.qtyAvailable), 0);
    const factory = await Factory.findByPk(factoryId, { transaction });

    if (totalAvailable < Number(quantity) && !(factory && factory.allowNegativeStock)) {
      throw new ValidationError(`Insufficient stock: available ${totalAvailable}, requested ${quantity}`);
    }

    const consumed = [];
    let remaining = Number(quantity);

    for (const lot of lots) {
      if (remaining <= 0) break;
      const take = Math.min(Number(lot.qtyAvailable), remaining);
      if (take <= 0) continue;
      await this.postEntry({
        factoryId, productId, lotId: lot.id, movementType, direction: 'OUT', quantity: take,
        referenceType, referenceId, transaction,
      });
      consumed.push({ lotId: lot.id, quantity: take });
      remaining -= take;
    }

    if (remaining > 0) {
      // Factory allows negative stock: post the deficit against the last lot
      // touched (or, if there were no lots at all, this factory/product has
      // no stock history yet — that's a data problem the caller should have
      // caught, so we surface it rather than inventing a lot).
      const deficitLot = lots[lots.length - 1];
      if (!deficitLot) throw new NotFoundError('No stock lots exist for this product at this factory');
      await this.postEntry({
        factoryId, productId, lotId: deficitLot.id, movementType, direction: 'OUT', quantity: remaining,
        referenceType, referenceId, notes: 'Negative stock (factory override)', transaction,
      });
      consumed.push({ lotId: deficitLot.id, quantity: remaining });
    }

    return consumed;
  }

  static async getStockBalance(factoryId, productId, transaction) {
    await this.promoteEligibleLots(factoryId, transaction);
    const result = await StockLot.findOne({
      attributes: [[literal('COALESCE(SUM("qtyAvailable"), 0)'), 'total']],
      where: { factoryId, productId, status: 'AVAILABLE' },
      transaction,
      raw: true,
    });
    return Number(result.total);
  }

  static async listLots(page, limit, { productId, status, search, sortBy, sortDir, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (productId) where.productId = productId;
    if (status) where.status = status;

    if (search) Object.assign(where, searchWhere(search, ['lotNumber']));
    return StockLot.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Product, as: 'product' }],
      order: toOrder(sortBy, sortDir, LOT_SORTABLE, [['originDate', 'ASC']]),
    });
  }

  static async listLedgerEntries(page, limit, { productId, lotId, movementType, search, sortBy, sortDir, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (productId) where.productId = productId;
    if (lotId) where.lotId = lotId;
    if (movementType) where.movementType = movementType;

    const include = [{ model: Product, as: 'product' }, { model: StockLot, as: 'lot' }];
    // `search` was accepted by the query schema and silently discarded here.
    if (search) {
      include[1] = { ...include[1], where: searchWhere(search, ['lotNumber']), required: true };
    }

    return StockLedgerEntry.findAndCountAll({
      where,
      limit,
      offset,
      include,
      order: toOrder(sortBy, sortDir, ENTRY_SORTABLE, [['createdAt', 'DESC']]),
    });
  }

  /**
   * BR-08 / AC-4.4: early release requires explicit override permission
   * (checked at the router), a mandatory reason, and leaves a permanent mark
   * on the lot so every stock report can flag it as early-released.
   */
  static async releaseLotEarly(lotId, reason) {
    const lot = await StockLot.findByPk(lotId);
    if (!lot) throw new NotFoundError('Stock lot not found');
    if (lot.status !== 'CURING') throw new ValidationError('Only a lot in CURING status can be released early');
    if (!reason || !String(reason).trim()) throw new ValidationError('A reason is required to release a lot early');

    return lot.update({
      status: 'AVAILABLE',
      releasedEarlyBy: getUserId() || null,
      releasedEarlyAt: new Date(),
      releasedEarlyReason: reason,
    });
  }

  /**
   * AP-1 / AC-5.2: the ledger is the source of truth; the per-lot running
   * quantity is a derived projection. This recomputes every lot's
   * qtyAvailable straight from the immutable ledger, which is the documented
   * recovery path if the two ever drift.
   */
  static async rebuildStockBalances({ factoryId } = {}) {
    const where = factoryId ? { factoryId } : {};
    const totals = await StockLedgerEntry.findAll({
      attributes: [
        'lotId',
        [
          literal(`COALESCE(SUM(CASE WHEN "direction" = 'IN' THEN "quantity" ELSE -"quantity" END), 0)`),
          'net',
        ],
      ],
      where,
      group: ['lotId'],
      raw: true,
    });

    let rebuilt = 0;
    for (const row of totals) {
      const [count] = await StockLot.update(
        { qtyAvailable: Number(row.net) },
        { where: { id: row.lotId }, hooks: false }
      );
      rebuilt += count;
    }
    return { lotsRebuilt: rebuilt };
  }

  /**
   * AC-5.2 / D2: compares each lot's stored qtyAvailable against the sum of
   * its ledger movements. Any row returned is a bug — the nightly job alerts
   * on a non-empty result.
   */
  static async reconcileLedgerVsBalances({ factoryId } = {}) {
    const where = factoryId ? { factoryId } : {};
    const totals = await StockLedgerEntry.findAll({
      attributes: [
        'lotId',
        [literal(`COALESCE(SUM(CASE WHEN "direction" = 'IN' THEN "quantity" ELSE -"quantity" END), 0)`), 'net'],
      ],
      where,
      group: ['lotId'],
      raw: true,
    });

    const lots = await StockLot.findAll({ where, attributes: ['id', 'lotNumber', 'factoryId', 'productId', 'qtyAvailable'] });
    const lotById = new Map(lots.map((l) => [l.id, l]));

    const discrepancies = [];
    for (const row of totals) {
      const lot = lotById.get(row.lotId);
      if (!lot) continue;
      const ledgerQty = Number(row.net);
      const balanceQty = Number(lot.qtyAvailable);
      if (Math.abs(ledgerQty - balanceQty) > 1e-6) {
        discrepancies.push({
          lotId: lot.id, lotNumber: lot.lotNumber, factoryId: lot.factoryId, productId: lot.productId,
          ledgerQty, balanceQty, drift: Number((balanceQty - ledgerQty).toFixed(4)),
        });
      }
    }
    return { checked: totals.length, discrepancies };
  }
}

module.exports = { StockLedgerService };
