const { Op } = require('sequelize');
const { StockLot } = require('./stockLot.model');
const { Product } = require('../products/product.model');
const { ProductCategory } = require('../products/productCategory.model');
const { Factory } = require('../factory/factory.model');

/** Global fallback when nothing more specific is configured (AC-2.2). */
const GLOBAL_DEFAULTS = Object.freeze({ slowMovingDays: 120, deadStockDays: 180, alertBeforeDays: 30 });

const FIELDS = ['slowMovingDays', 'deadStockDays', 'alertBeforeDays'];

/** Whole calendar days between two dates, timezone-independent. */
const toDayUTC = (d) => {
  const date = new Date(d);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
};
const daysBetween = (from, to) => Math.floor((toDayUTC(to) - toDayUTC(from)) / 86400000);

class AgeingService {
  /**
   * FR-M22-1 / FR-M03-5: resolves ageing thresholds by walking
   * Product -> Category -> Factory -> Global and taking the most specific
   * non-null value **per field**, not per level. A product that overrides only
   * deadStockDays still inherits slowMovingDays from its category — which is
   * exactly what AC-2.2 asserts.
   */
  static resolveThresholds({ product, category, factory }) {
    const levels = [product, category, factory];
    const resolved = {};
    for (const field of FIELDS) {
      const hit = levels.find((level) => level && level[field] !== null && level[field] !== undefined);
      resolved[field] = hit ? Number(hit[field]) : GLOBAL_DEFAULTS[field];
    }
    return resolved;
  }

  static async resolveThresholdsFor(productId, factoryId) {
    const product = await Product.findByPk(productId, { include: [{ model: ProductCategory, as: 'category' }] });
    const factory = factoryId ? await Factory.findByPk(factoryId) : null;
    return this.resolveThresholds({ product, category: product?.category, factory });
  }

  static classify(ageDays, { slowMovingDays, deadStockDays }) {
    if (ageDays >= deadStockDays) return 'DEAD';
    if (ageDays >= slowMovingDays) return 'SLOW_MOVING';
    return 'FRESH';
  }

  /**
   * Nightly reclassification of every open lot (FR-M22-4).
   *
   * CURING lots are deliberately excluded (FR-M22-3 / AC-13.2): stock that
   * isn't sellable yet isn't "slow moving", and counting it as dead would
   * flag every fresh casting the day it's poured.
   *
   * Returns the lots that crossed into the near-dead alert window and had not
   * been alerted before, so the caller can raise notifications idempotently.
   */
  static async reclassifyAll({ asOf = new Date() } = {}) {
    const lots = await StockLot.findAll({
      where: { status: 'AVAILABLE', qtyAvailable: { [Op.gt]: 0 } },
      include: [{ model: Product, as: 'product', include: [{ model: ProductCategory, as: 'category' }] }],
    });

    const factories = await Factory.findAll();
    const factoryById = new Map(factories.map((f) => [f.id, f]));

    const summary = { scanned: lots.length, fresh: 0, slowMoving: 0, dead: 0 };
    const newlyNearDead = [];

    for (const lot of lots) {
      const thresholds = this.resolveThresholds({
        product: lot.product,
        category: lot.product?.category,
        factory: factoryById.get(lot.factoryId),
      });

      const ageDays = daysBetween(lot.originDate, asOf);
      const ageingClass = this.classify(ageDays, thresholds);

      const patch = { ageDays, ageingClass, ageingComputedAt: asOf };

      // AC-13.3: alert once, when the lot first enters the window
      // (deadStockDays - age <= alertBeforeDays), never again on later runs.
      const daysToDead = thresholds.deadStockDays - ageDays;
      const inAlertWindow = ageingClass !== 'DEAD' && daysToDead <= thresholds.alertBeforeDays;
      if (inAlertWindow && !lot.nearDeadAlertedAt) {
        patch.nearDeadAlertedAt = asOf;
        newlyNearDead.push({ lot, daysToDead, thresholds });
      }

      await lot.update(patch, { hooks: false });

      if (ageingClass === 'DEAD') summary.dead += 1;
      else if (ageingClass === 'SLOW_MOVING') summary.slowMoving += 1;
      else summary.fresh += 1;
    }

    return { ...summary, newlyNearDead };
  }

  /** FR-M22-8: dead and near-dead lots, oldest first, with a suggested discount tier. */
  static async liquidationReport(factoryId) {
    const where = { status: 'AVAILABLE', qtyAvailable: { [Op.gt]: 0 }, ageingClass: { [Op.in]: ['DEAD', 'SLOW_MOVING'] } };
    if (factoryId) where.factoryId = factoryId;

    const lots = await StockLot.findAll({
      where,
      include: [{ model: Product, as: 'product', include: [{ model: ProductCategory, as: 'category' }] }],
      order: [['ageDays', 'DESC']],
    });

    const factories = await Factory.findAll();
    const factoryById = new Map(factories.map((f) => [f.id, f]));

    return lots.map((lot) => {
      const thresholds = this.resolveThresholds({
        product: lot.product, category: lot.product?.category, factory: factoryById.get(lot.factoryId),
      });
      const ageDays = Number(lot.ageDays ?? 0);
      return {
        lotId: lot.id,
        lotNumber: lot.lotNumber,
        factoryId: lot.factoryId,
        productId: lot.productId,
        productName: lot.product?.name,
        quantity: Number(lot.qtyAvailable),
        valuePaise: Math.round(Number(lot.qtyAvailable) * Number(lot.product?.standardCostPaise || 0)),
        ageDays,
        ageingClass: lot.ageingClass,
        daysRemaining: Math.max(0, thresholds.deadStockDays - ageDays),
        // Deeper discount the longer it has sat — a starting point for the
        // commercial decision, not an automatic repricing.
        suggestedDiscountPercent: ageDays >= thresholds.deadStockDays * 2 ? 25 : lot.ageingClass === 'DEAD' ? 15 : 5,
      };
    });
  }
}

module.exports = { AgeingService, GLOBAL_DEFAULTS };
