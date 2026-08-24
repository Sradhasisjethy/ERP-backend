const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { StockAdjustment } = require('./stockAdjustment.model');
const { StockLot } = require('./stockLot.model');
const { StockLedgerService } = require('./stockLedger.service');
const { Product } = require('../products/product.model');
const { Factory } = require('../factory/factory.model');
const { FinancialYear } = require('../factory/financialYear.model');
const { DocumentNumberingService } = require('../documentSeries/documentNumbering.service');
const { toOrder } = require('../../utils/pagination');
const { getUserId } = require('../../core/tenantContext');
const { NotFoundError, ValidationError } = require('../../core/AppError');

const SORTABLE = ['adjustmentNumber', 'adjustmentDate', 'adjustmentQty', 'createdAt'];

const getCurrentFinancialYearId = async (transaction) => {
  const fy = await FinancialYear.findOne({ where: { isCurrent: true }, transaction });
  if (!fy) throw new ValidationError('No current financial year is configured (see Factories > Financial Years)');
  return fy.id;
};

/**
 * M22 — physical stock count corrections.
 *
 * The one stock mutation the system had no way to make. Every other movement
 * type is driven by a business document; a count discrepancy has none, so
 * before this a warehouse that counted 92 against a system figure of 100 had
 * no honest way to record the difference.
 *
 * Deliberately thin: the correction itself is an ordinary ledger entry posted
 * through StockLedgerService.postEntry, so it inherits the lot lock, the
 * negative-stock rule (BR-04) and the reconciliation guarantee unchanged. This
 * service's job is to work out the delta safely and to record why.
 */
class StockAdjustmentService {
  static async list(page, limit, { productId, lotId, sortBy, sortDir, baseWhere = {} } = {}) {
    const offset = (page - 1) * limit;
    const where = { ...baseWhere };
    if (productId) where.productId = productId;
    if (lotId) where.lotId = lotId;

    return StockAdjustment.findAndCountAll({
      where,
      limit,
      offset,
      include: [{ model: Product, as: 'product' }, { model: StockLot, as: 'lot' }],
      order: toOrder(sortBy, sortDir, SORTABLE, [['adjustmentDate', 'DESC'], ['createdAt', 'DESC']]),
    });
  }

  static async get(id) {
    const adjustment = await StockAdjustment.findByPk(id, {
      include: [{ model: Product, as: 'product' }, { model: StockLot, as: 'lot' }],
    });
    if (!adjustment) throw new NotFoundError('Stock adjustment not found');
    return adjustment;
  }

  /**
   * Records a counted quantity against a lot and posts the difference.
   *
   * `countedQty` is what the warehouse physically found — an absolute figure,
   * not a delta. Taking the count rather than the difference is what makes the
   * operation safe under concurrency: the previous quantity is read under the
   * same row lock the posting uses, so two people counting the same lot cannot
   * both apply a delta against a stale figure.
   */
  static async create({ factoryId, productId, lotId, countedQty, reason, adjustmentDate }) {
    if (!reason || !String(reason).trim()) {
      throw new ValidationError('A reason is required — an unexplained stock correction is not auditable');
    }
    const counted = Number(countedQty);
    if (!Number.isFinite(counted) || counted < 0) {
      throw new ValidationError('Counted quantity must be zero or more');
    }

    return sequelize.transaction(async (transaction) => {
      // FOR UPDATE before reading previousQty: this is the figure the whole
      // adjustment is computed against, and postEntry will take the same lock.
      const lot = await StockLot.findOne({
        where: { id: lotId, factoryId, productId },
        transaction,
        lock: transaction.LOCK.UPDATE,
      });
      if (!lot) throw new NotFoundError('Stock lot not found for this product at this location');

      const previousQty = Number(lot.qtyAvailable);
      const adjustmentQty = Number((counted - previousQty).toFixed(4));

      if (adjustmentQty === 0) {
        throw new ValidationError(
          `No adjustment needed — the counted quantity already matches the system quantity (${previousQty})`
        );
      }

      // BR-04 is enforced inside postEntry against the lot, but checking here
      // lets the message name the count rather than the internal movement.
      if (counted < 0) throw new ValidationError('Counted quantity must be zero or more');

      const financialYearId = await getCurrentFinancialYearId(transaction);
      const { documentNumber } = await DocumentNumberingService.allocate('STOCK_ADJUSTMENT', {
        factoryId,
        financialYearId,
        prefix: 'ADJ',
        transaction,
      });

      const entry = await StockLedgerService.postEntry({
        factoryId,
        productId,
        lotId,
        movementType: adjustmentQty > 0 ? 'ADJUSTMENT_IN' : 'ADJUSTMENT_OUT',
        direction: adjustmentQty > 0 ? 'IN' : 'OUT',
        quantity: Math.abs(adjustmentQty),
        referenceType: 'StockAdjustment',
        // The document id is assigned below; the entry is linked back to it
        // immediately afterwards so both directions of the pair resolve.
        referenceId: lot.id,
        notes: `Stock adjustment: ${reason}`,
        transaction,
      });

      const adjustment = await StockAdjustment.create(
        {
          factoryId,
          productId,
          lotId,
          adjustmentNumber: documentNumber,
          adjustmentDate: adjustmentDate || new Date().toISOString().slice(0, 10),
          previousQty,
          countedQty: counted,
          adjustmentQty,
          newQty: counted,
          reason: String(reason).trim(),
          stockLedgerEntryId: entry.id,
          createdBy: getUserId() || null,
        },
        { transaction }
      );

      await entry.update({ referenceId: adjustment.id }, { transaction });

      return this.get(adjustment.id);
    });
  }
}

module.exports = { StockAdjustmentService };
