const { BundleExpansionService } = require('./bundleExpansion.service');
const { ReservationService } = require('../inventory/reservation.service');
const { Product } = require('../products/product.model');
const { NotFoundError } = require('../../core/AppError');

/**
 * How many complete bundles can actually be promised. Spec §8, Phase 6.
 *
 * A bundled product is a phantom: nobody stocks "Printer X with starter kit",
 * they stock printers, cables and toner. So promising one is a question about
 * the scarcest component, not about the parent:
 *
 *     available bundles = min over components of floor(available_i / qty_i)
 *
 * The parent's own stock counts too when it is a real stocked item, which it
 * usually is — the printer itself is one of the constraints.
 *
 * Availability comes from `ReservationService.getAvailability`, which already
 * subtracts reserved, curing, in-transit and awaiting-QC stock. Reimplementing
 * that arithmetic here would quietly promise stock the plant cannot ship.
 */
class BundleAvailabilityService {
  /**
   * @returns {Promise<object>} the promise count, plus the component that caps
   *   it — "we can do 12, limited by the cable" is the answer a salesperson
   *   needs, not a bare number.
   */
  static async availableBundles(parentProductId, { factoryId, onDate } = {}) {
    const product = await Product.findByPk(parentProductId);
    if (!product) throw new NotFoundError('Product not found');

    const plan = await BundleExpansionService.reconcile({
      parentProductId,
      parentLineId: null,
      newParentQty: 1,
      presentComponents: [],
      suppressedProductIds: [],
      context: { factoryId, onDate },
    });

    const parentAvailability = await ReservationService.getAvailability(factoryId, parentProductId);

    // Per-unit requirements. A FIXED component is not a constraint on how many
    // bundles can be sold — one installation kit covers the whole order — so it
    // is reported but does not cap the count.
    const constraints = [
      {
        productId: parentProductId,
        productName: product.name,
        role: 'PARENT',
        perBundle: 1,
        available: Number(parentAvailability.available),
        limits: true,
      },
    ];

    for (const component of plan.components) {
      if (component.action === 'DETACH') continue;

      const snapshotEntry = (plan.snapshot?.components || []).find(
        (c) => c.componentProductId === component.componentProductId
      );
      const scaling = snapshotEntry?.scalingMode || 'PROPORTIONAL';
      const perBundle = scaling === 'PROPORTIONAL' ? Number(snapshotEntry?.quantity ?? component.qty) : 0;

      const availability = await ReservationService.getAvailability(factoryId, component.componentProductId);

      constraints.push({
        productId: component.componentProductId,
        productName: component.productName,
        role: 'COMPONENT',
        scalingMode: scaling,
        perBundle,
        available: Number(availability.available),
        // A FIXED component is a per-order item, not a per-unit one, so it
        // cannot be what limits the quantity.
        limits: scaling === 'PROPORTIONAL' && perBundle > 0,
      });
    }

    const limiting = constraints.filter((c) => c.limits);

    // No rule, or nothing that scales: the parent's own stock is the answer.
    const capacities = limiting.map((c) => ({
      ...c,
      // Whole bundles only. Half a printer with one cable is not something that
      // can be promised to anybody.
      capacity: Math.floor(c.available / c.perBundle),
    }));

    const availableBundles = capacities.length
      ? Math.max(0, Math.min(...capacities.map((c) => c.capacity)))
      : 0;

    const bottleneck = capacities
      .filter((c) => c.capacity === availableBundles)
      .sort((a, b) => (a.role === 'PARENT' ? 1 : -1))[0] || null;

    return {
      parentProductId,
      productName: product.name,
      factoryId,
      isBundle: !!plan.bundleRuleId,
      bundleRuleId: plan.bundleRuleId,
      availableBundles,
      // Named so the salesperson can say "we could do 40 if we had more cable"
      // rather than just being told no.
      limitedBy: bottleneck
        ? {
            productId: bottleneck.productId,
            productName: bottleneck.productName,
            available: bottleneck.available,
            perBundle: bottleneck.perBundle,
          }
        : null,
      constraints: capacities.length ? capacities : constraints,
    };
  }
}

module.exports = { BundleAvailabilityService };
