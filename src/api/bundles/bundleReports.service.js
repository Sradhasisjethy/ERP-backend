const { Op } = require('sequelize');
const { SalesOrder } = require('../sales/salesOrder.model');
const { SalesOrderLine } = require('../sales/salesOrderLine.model');
const { Product } = require('../products/product.model');
const { BundleOverrideAudit } = require('./bundleOverrideAudit.model');
const { OverrideReasonCode } = require('./overrideReasonCode.model');
const { ValidationError } = require('../../core/AppError');

/**
 * Attach rate — how often an accessory actually goes out with the product it
 * belongs to, and when it does not, why.
 *
 * This is the payoff for the whole audit table. "The starter kit isn't selling"
 * is an opinion; "the kit was offered on 210 orders, went out on 60, and 90 of
 * the removals said the customer already had one" is something a business can
 * act on — and the three groupings answer three different questions:
 *
 *   by product      is the bundle itself wrong?
 *   by salesperson  is one desk quietly dropping it?
 *   by location     is it a regional objection?
 */

const GROUPINGS = {
  product: { column: 'componentProductId', label: 'componentProductId' },
  salesperson: { column: 'actorId', label: 'actorId' },
  location: { column: 'factoryId', label: 'factoryId' },
};

class BundleReportsService {
  /**
   * @param {object} filters
   * @param {string} filters.groupBy  product | salesperson | location
   */
  static async attachRate({ groupBy = 'product', fromDate, toDate, factoryId, parentProductId } = {}) {
    if (!GROUPINGS[groupBy]) {
      throw new ValidationError(`Group by one of: ${Object.keys(GROUPINGS).join(', ')}`);
    }
    if (!fromDate || !toDate) throw new ValidationError('A date range is required');

    const orderWhere = {
      orderDate: { [Op.between]: [fromDate, toDate] },
      // A cancelled order tells you nothing about whether an accessory sells.
      status: { [Op.ne]: 'CANCELLED' },
      ...(factoryId ? { factoryId } : {}),
    };

    // Every component that was offered: one row per (parent line, component),
    // whether it survived to the order or was removed from it.
    const attached = await SalesOrderLine.findAll({
      where: { lineRole: 'COMPONENT', syncState: { [Op.ne]: 'DETACHED' } },
      include: [
        { model: SalesOrder, as: 'salesOrder', attributes: ['id', 'factoryId', 'orderDate'], where: orderWhere, required: true },
        { model: Product, as: 'product', attributes: ['id', 'name', 'code'] },
      ],
    });

    // The audit table carries no foreign key to the order — an audit row that
    // vanishes with the document it audits is not an audit — so the date and
    // location filter is applied by resolving the orders first and matching on
    // id, rather than by a join that does not exist.
    const ordersInScope = await SalesOrder.findAll({
      where: orderWhere,
      attributes: ['id', 'factoryId', 'orderDate'],
    });
    const orderById = new Map(ordersInScope.map((o) => [o.id, o]));

    const removed = (
      await BundleOverrideAudit.findAll({
        where: { action: 'SUPPRESSED', salesOrderId: { [Op.in]: [...orderById.keys()] } },
      })
    ).map((audit) => ({ audit, salesOrder: orderById.get(audit.salesOrderId) }));

    // Filter to one parent product when asked. The audit row does not carry the
    // parent's product, so it is resolved through the line it belongs to.
    let parentLineFilter = null;
    if (parentProductId) {
      const parents = await SalesOrderLine.findAll({
        where: { lineRole: 'PARENT', productId: parentProductId },
        attributes: ['id'],
      });
      parentLineFilter = new Set(parents.map((p) => p.id));
    }

    const buckets = new Map();
    const bucketFor = (key) => {
      if (!buckets.has(key)) {
        buckets.set(key, { key, attached: 0, removed: 0, reasons: {} });
      }
      return buckets.get(key);
    };

    const keyOf = (row, salesOrder) => {
      if (groupBy === 'product') return row.componentProductId || row.productId;
      if (groupBy === 'location') return salesOrder?.factoryId || null;
      return row.actorId || row.createdBy || null;
    };

    for (const line of attached) {
      if (parentLineFilter && !parentLineFilter.has(line.parentLineId)) continue;
      const bucket = bucketFor(keyOf(line, line.salesOrder));
      bucket.attached += 1;
      if (groupBy === 'product' && line.product) bucket.label = line.product.name;
    }

    for (const { audit, salesOrder } of removed) {
      if (parentLineFilter && !parentLineFilter.has(audit.parentLineId)) continue;
      const bucket = bucketFor(keyOf(audit, salesOrder));
      bucket.removed += 1;
      const reason = audit.reasonCode || 'UNSTATED';
      bucket.reasons[reason] = (bucket.reasons[reason] || 0) + 1;
    }

    const reasonLabels = new Map(
      (await OverrideReasonCode.findAll()).map((r) => [r.code, r.label])
    );

    const rows = [...buckets.values()]
      .filter((b) => b.key)
      .map((b) => {
        const offered = b.attached + b.removed;
        return {
          key: b.key,
          label: b.label || null,
          offered,
          attached: b.attached,
          removed: b.removed,
          // Rounded to one decimal: this is read as a percentage on a screen,
          // not reconciled against anything.
          attachRatePercent: offered ? Math.round((b.attached / offered) * 1000) / 10 : 0,
          reasons: Object.entries(b.reasons)
            .map(([code, count]) => ({ code, label: reasonLabels.get(code) || code, count }))
            .sort((a, b2) => b2.count - a.count),
        };
      })
      .sort((a, b) => b.offered - a.offered);

    return {
      groupBy,
      fromDate,
      toDate,
      rows,
      totals: {
        offered: rows.reduce((n, r) => n + r.offered, 0),
        attached: rows.reduce((n, r) => n + r.attached, 0),
        removed: rows.reduce((n, r) => n + r.removed, 0),
      },
    };
  }

  /** The raw override trail for one order — what was changed, by whom, and why. */
  static async overrideHistory(salesOrderId) {
    return BundleOverrideAudit.findAll({
      where: { salesOrderId },
      order: [['occurredAt', 'ASC']],
    });
  }
}

module.exports = { BundleReportsService };
