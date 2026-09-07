const { Op, fn, col, literal } = require('sequelize');
const { StockLot } = require('./stockLot.model');
const { StockReservation } = require('./stockReservation.model');
const { StockTransferLine } = require('../transfer/stockTransferLine.model');
const { StockTransfer } = require('../transfer/stockTransfer.model');
const { Product } = require('../products/product.model');
const { Uom } = require('../products/uom.model');

/**
 * Stock by material, rather than by lot.
 *
 * The lot list answers "what individual batches do we hold"; this answers "how
 * much cement do we have", which is the question anyone ordering raw material
 * or promising a delivery actually asks. Reaching it before meant reading the
 * lot list and adding up in your head.
 *
 * The column definitions are deliberately identical to
 * ReservationService.getAvailability — the same status buckets, the same
 * `available = sellable - reserved`. Two screens disagreeing about what is
 * available is worse than not having the second screen, so where that method
 * splits a figure out, so does this.
 *
 * Aggregated in SQL rather than by walking products and calling getAvailability
 * per row: a plant with a few hundred materials would otherwise issue a few
 * hundred round trips to paint one table.
 */

/** SUM(qtyAvailable) for the lots in one status. */
const sumWhereStatus = (status, alias) => [
  fn('SUM', literal(`CASE WHEN "StockLot"."status" = '${status}' THEN "StockLot"."qtyAvailable" ELSE 0 END`)),
  alias,
];

class StockSummaryService {
  /**
   * @param baseWhere factory scoping from the controller (BR-29) — stock is
   *                  location data and must never be listed across factories a
   *                  user has no grant for.
   */
  static async listByMaterial(page, limit, { search, category, hideZero, baseWhere = {} } = {}) {
    // Lots carry the physical position.
    const lotRows = await StockLot.findAll({
      attributes: [
        'productId',
        [fn('SUM', col('StockLot.qtyAvailable')), 'onHand'],
        sumWhereStatus('AVAILABLE', 'sellable'),
        sumWhereStatus('CURING', 'curing'),
        sumWhereStatus('QC_HOLD', 'awaitingQc'),
        sumWhereStatus('QC_FAILED', 'qcFailed'),
        sumWhereStatus('WITH_CONTRACTOR', 'withContractor'),
      ],
      where: { ...baseWhere, qtyAvailable: { [Op.gt]: 0 } },
      group: ['StockLot.productId'],
      raw: true,
    });

    const reservationRows = await StockReservation.findAll({
      attributes: ['productId', [fn('SUM', col('quantity')), 'reserved']],
      where: { ...baseWhere, status: 'ACTIVE' },
      group: ['productId'],
      raw: true,
    });

    // Stock dispatched from this factory but not yet received elsewhere belongs
    // to neither factory's available balance (AC-5.6).
    const transferWhere = baseWhere.factoryId
      ? { status: 'IN_TRANSIT', fromFactoryId: baseWhere.factoryId }
      : { status: 'IN_TRANSIT' };
    const inTransitRows = await StockTransferLine.findAll({
      attributes: ['productId', [fn('SUM', col('StockTransferLine.quantity')), 'inTransit']],
      include: [{ model: StockTransfer, as: 'stockTransfer', attributes: [], where: transferWhere, required: true }],
      group: ['StockTransferLine.productId'],
      raw: true,
    });

    const byProduct = new Map();
    const bucket = (id) => {
      if (!byProduct.has(id)) {
        byProduct.set(id, {
          productId: id, onHand: 0, sellable: 0, curing: 0, awaitingQc: 0,
          qcFailed: 0, withContractor: 0, reserved: 0, inTransit: 0,
        });
      }
      return byProduct.get(id);
    };

    for (const row of lotRows) {
      Object.assign(bucket(row.productId), {
        onHand: Number(row.onHand || 0),
        sellable: Number(row.sellable || 0),
        curing: Number(row.curing || 0),
        awaitingQc: Number(row.awaitingQc || 0),
        qcFailed: Number(row.qcFailed || 0),
        withContractor: Number(row.withContractor || 0),
      });
    }
    for (const row of reservationRows) bucket(row.productId).reserved = Number(row.reserved || 0);
    for (const row of inTransitRows) bucket(row.productId).inTransit = Number(row.inTransit || 0);

    // Products are listed even at zero: "we have none" is an answer, and a
    // material that has run out is exactly what someone reordering is looking
    // for. `hideZero` is opt-in for anyone who wants the short list.
    const productWhere = {};
    // Three categories from two columns. An accessory is a product with
    // isAccessory set, and it would otherwise also be a FINISHED_GOOD — so
    // "Finished goods" deliberately excludes them. Overlapping groups make the
    // three filters unable to account for the whole list, which is worse than
    // having no filter.
    if (category === 'RAW_MATERIAL') productWhere.productType = 'RAW_MATERIAL';
    if (category === 'FINISHED_GOOD') Object.assign(productWhere, { productType: 'FINISHED_GOOD', isAccessory: false });
    if (category === 'ACCESSORY') productWhere.isAccessory = true;
    if (search) {
      productWhere[Op.or] = [
        { name: { [Op.iLike]: `%${search}%` } },
        { code: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const products = await Product.findAll({
      where: productWhere,
      include: [{ model: Uom, as: 'uom', attributes: ['code', 'name'] }],
      order: [['name', 'ASC']],
    });

    const rows = products
      .map((product) => {
        const totals = byProduct.get(product.id) || {
          onHand: 0, sellable: 0, curing: 0, awaitingQc: 0, qcFailed: 0,
          withContractor: 0, reserved: 0, inTransit: 0,
        };
        const reorderLevel = product.reorderLevel === null ? null : Number(product.reorderLevel);
        return {
          productId: product.id,
          productName: product.name,
          productCode: product.code,
          productType: product.productType,
          isAccessory: product.isAccessory,
          uom: product.uom?.code || null,
          reorderLevel,
          ...totals,
          available: Math.max(0, totals.sellable - totals.reserved),
          // Surfaced rather than left for the caller to derive, so the list and
          // the reorder alerts on the dashboard cannot disagree.
          belowReorder: reorderLevel !== null && reorderLevel > 0 && totals.onHand < reorderLevel,
        };
      })
      .filter((row) => (hideZero ? row.onHand > 0 : true));

    const offset = (page - 1) * limit;
    return { count: rows.length, rows: rows.slice(offset, offset + limit) };
  }
}

module.exports = { StockSummaryService };
