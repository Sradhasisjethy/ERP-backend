const { Op } = require('sequelize');
const { BundleRule } = require('./bundleRule.model');
const { BundleComponent } = require('./bundleComponent.model');
const { Product } = require('../products/product.model');
const { HsnCode } = require('../products/hsnCode.model');
const { PricingService } = require('../pricing/pricing.service');
const { addPaise } = require('../../utils/money');

/**
 * Bundle expansion — the pure core. See docs/specs/bundle-kitting.md §2 and §4.
 *
 * Two invariants shape everything here and are easy to erode later:
 *
 *   §2.1  This is the ONLY place expansion happens. Not the frontend, not a DB
 *         trigger, not a second copy in the import path.
 *   §2.2  reconcile() is pure. It reads master data and returns a plan. It
 *         performs no writes, and tests assert row counts are unchanged after
 *         calling it. Phase 2 applies the plan; it does not move logic in here.
 *
 * The caller supplies what is already on the document (`presentComponents`) and
 * what has been suppressed (`suppressedProductIds`) rather than this service
 * reading them, so the same function serves a live document and a preview of a
 * document that does not exist yet.
 */

/** A rule is in force when it is ACTIVE and the date falls inside its window. */
const resolveRuleForDate = async (parentProductId, onDate) => {
  const date = onDate || new Date().toISOString().slice(0, 10);

  const candidates = await BundleRule.findAll({
    where: {
      parentProductId,
      status: 'ACTIVE',
      effectiveFrom: { [Op.lte]: date },
      [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: date } }],
    },
    include: [{ model: BundleComponent, as: 'components' }],
    // Highest priority wins; newest effective date breaks a tie, then version.
    order: [['priority', 'DESC'], ['effectiveFrom', 'DESC'], ['version', 'DESC']],
  });

  return candidates[0] || null;
};

/**
 * Frozen copy of the rule as it stood at expansion time (§2.3).
 *
 * Stored on the line so reading a historical document never re-resolves from
 * live master data — editing a rule must not retroactively change what a
 * customer was quoted.
 */
const snapshotOf = (rule) => ({
  bundleRuleId: rule.id,
  code: rule.code,
  name: rule.name,
  version: rule.version,
  bundleType: rule.bundleType,
  taxTreatment: rule.taxTreatment,
  effectiveFrom: rule.effectiveFrom,
  components: (rule.components || [])
    .slice()
    .sort((a, b) => a.sequence - b.sequence)
    .map((c) => ({
      componentProductId: c.componentProductId,
      quantity: Number(c.quantity),
      scalingMode: c.scalingMode,
      uomId: c.uomId,
      isMandatory: c.isMandatory,
      defaultSelected: c.defaultSelected,
      sequence: c.sequence,
    })),
});

/**
 * GST for one component.
 *
 * The rate comes from the component's own HSN — never a single rate on the
 * document header. Two components of one bundle routinely sit at different
 * rates (a cable at 12% beside a printer at 18%), and GSTR-1 needs the
 * HSN-wise breakup, so a header rate would be both wrong and unfilable.
 * Nobody types this: it is configured once on the HSN master and inherited by
 * every product pointing at it.
 */
const taxFor = (product, taxableAmountPaise) => {
  const gstRatePercent = Number(product?.hsnCode?.gstRatePercent || 0);
  return {
    gstRatePercent,
    hsnCode: product?.hsnCode?.code || null,
    // Rounded per line, matching invoicing.service.js. Rounding the document
    // total instead would drift against the invoice raised from it.
    taxPaise: Math.round((taxableAmountPaise * gstRatePercent) / 100),
  };
};

class BundleExpansionService {
  /**
   * Which of these products carry a bundle rule in force on this date.
   *
   * Callers use it to decide whether a line needs expanding at all, so an order
   * of ordinary products never touches the bundle tables.
   */
  static async productsWithActiveRules(productIds, onDate) {
    if (!productIds?.length) return new Set();
    const date = onDate || new Date().toISOString().slice(0, 10);

    const rules = await BundleRule.findAll({
      where: {
        parentProductId: { [Op.in]: productIds },
        status: 'ACTIVE',
        effectiveFrom: { [Op.lte]: date },
        [Op.or]: [{ effectiveTo: null }, { effectiveTo: { [Op.gte]: date } }],
      },
      attributes: ['parentProductId'],
    });
    return new Set(rules.map((r) => r.parentProductId));
  }

  /**
   * Builds the plan for one parent line. Handles every mutation: the caller
   * decides what changed *before* calling, and this decides what the document
   * should look like as a result (§4).
   *
   * @returns {Promise<object>} plan — never a mutation
   */
  static async reconcile({
    parentProductId,
    parentLineId,
    newParentQty,
    presentComponents = [],
    suppressedProductIds = [],
    // The rule this line was already expanded under. When present it is used
    // as-is and no live lookup happens: publishing v2 of a rule must not change
    // an order that is already open (invariant 3, spec test 10). A line with no
    // snapshot — a brand new one — resolves against master data instead.
    frozenSnapshot = null,
    context = {},
  }) {
    const empty = {
      parentLineId,
      parentProductId,
      parentQty: Number(newParentQty),
      bundleRuleId: null,
      bundleRuleVersion: null,
      snapshot: null,
      components: [],
      optional: [],
      warnings: [],
      totals: { taxableAmountPaise: 0, taxPaise: 0, componentsTotalPaise: 0, taxSummary: [] },
    };

    let snapshot = frozenSnapshot;
    if (!snapshot) {
      const rule = await resolveRuleForDate(parentProductId, context.onDate);
      if (!rule) return empty;   // no bundle, or another tenant's — CLS scopes the read
      snapshot = snapshotOf(rule);
    }
    if (!snapshot.components?.length && !presentComponents.length) return empty;
    const suppressed = new Set(suppressedProductIds);

    // Keyed by product WITHIN this parent line (§2.8). Keying by
    // (documentId, productId) instead is what breaks two lines of the same
    // product on one order — spec test 11.
    const present = new Map(presentComponents.map((c) => [c.componentProductId, c]));

    const productIds = snapshot.components.map((c) => c.componentProductId);
    const products = await Product.findAll({
      where: { id: { [Op.in]: productIds } },
      include: [{ model: HsnCode, as: 'hsnCode' }],
    });
    const productById = new Map(products.map((p) => [p.id, p]));

    const components = [];
    const optional = [];
    const warnings = [];

    for (const c of snapshot.components) {
      // §2.4: the tombstone is checked first and always wins. A removed
      // accessory never returns on its own, whatever else changes.
      if (suppressed.has(c.componentProductId)) continue;

      const product = productById.get(c.componentProductId);
      const targetQty =
        c.scalingMode === 'PROPORTIONAL' ? c.quantity * Number(newParentQty) : c.quantity;

      const existing = present.get(c.componentProductId);

      if (!existing) {
        if (!c.defaultSelected) {
          // Offered in the picker, never auto-created.
          optional.push({
            componentProductId: c.componentProductId,
            productName: product?.name || null,
            suggestedQty: targetQty,
            isMandatory: c.isMandatory,
            sequence: c.sequence,
          });
          continue;
        }

        const unitPricePaise = (await PricingService.resolveRate(c.componentProductId, {
          partyId: context.partyId,
          priceType: context.priceType,
        })) ?? 0;

        components.push(
          this._entry({
            action: 'CREATE',
            component: c,
            product,
            qty: targetQty,
            systemQty: targetQty,
            unitPricePaise: Number(unitPricePaise),
            systemUnitPricePaise: Number(unitPricePaise),
            origin: 'RULE_AUTO',
            syncState: 'SYNCED',
          })
        );
        continue;
      }

      // The baseline is refreshed even when the line is overridden — it is the
      // only reliable answer to "has the user touched this?" and it drives the
      // reset action.
      const systemUnitPricePaise = Number(
        (await PricingService.resolveRate(c.componentProductId, {
          partyId: context.partyId,
          priceType: context.priceType,
        })) ?? 0
      );

      const priceOverridden = existing.syncState === 'PRICE_OVERRIDDEN';

      // §2.5: quantity is only rescaled while the system still owns it.
      // Absolute, never ratio — see §4. A user who typed 5 keeps 5.
      const qty = existing.syncState === 'QTY_OVERRIDDEN' ? Number(existing.qty) : targetQty;
      const unitPricePaise = priceOverridden
        ? Number(existing.unitPricePaise)
        : systemUnitPricePaise;

      if (existing.syncState === 'QTY_OVERRIDDEN' && qty !== targetQty) {
        warnings.push({
          code: 'QTY_VARIANCE',
          lineId: existing.lineId,
          componentProductId: c.componentProductId,
          currentQty: qty,
          suggestedQty: targetQty,
        });
      }

      components.push(
        this._entry({
          action: 'UPDATE',
          component: c,
          product,
          lineId: existing.lineId,
          qty,
          systemQty: targetQty,
          unitPricePaise,
          systemUnitPricePaise,
          origin: existing.origin || 'RULE_AUTO',
          syncState: existing.syncState || 'SYNCED',
        })
      );
    }

    // On the document but no longer in the rule: keep the line, stop managing
    // it. Deleting it would silently drop something a customer was quoted.
    const ruleProductIds = new Set(snapshot.components.map((c) => c.componentProductId));
    for (const existing of presentComponents) {
      if (ruleProductIds.has(existing.componentProductId)) continue;

      const product = productById.get(existing.componentProductId) || null;
      components.push(
        this._entry({
          action: 'DETACH',
          component: { componentProductId: existing.componentProductId, uomId: existing.uomId, sequence: 999, isMandatory: false },
          product,
          lineId: existing.lineId,
          qty: Number(existing.qty),
          systemQty: existing.systemQty === undefined ? null : Number(existing.systemQty),
          unitPricePaise: Number(existing.unitPricePaise || 0),
          systemUnitPricePaise: Number(existing.systemUnitPricePaise || 0),
          origin: existing.origin || 'MANUAL',
          syncState: 'DETACHED',
        })
      );
      warnings.push({
        code: 'DETACHED_COMPONENT',
        lineId: existing.lineId,
        componentProductId: existing.componentProductId,
      });
    }

    components.sort((a, b) => a.sequence - b.sequence);

    return {
      parentLineId,
      parentProductId,
      parentQty: Number(newParentQty),
      bundleRuleId: snapshot.bundleRuleId,
      bundleRuleVersion: snapshot.version,
      snapshot,
      components,
      optional: optional.sort((a, b) => a.sequence - b.sequence),
      warnings,
      totals: this._totals(components),
    };
  }

  /** One planned component line. All money is integer paise (§2.9). */
  static _entry({
    action, component, product, lineId = null, qty, systemQty,
    unitPricePaise, systemUnitPricePaise, origin, syncState,
  }) {
    const taxableAmountPaise = Math.round(Number(qty) * Number(unitPricePaise));
    const { gstRatePercent, hsnCode, taxPaise } = taxFor(product, taxableAmountPaise);

    return {
      action,
      lineId,
      componentProductId: component.componentProductId,
      productName: product?.name || null,
      uomId: component.uomId,
      sequence: component.sequence,
      isMandatory: component.isMandatory,

      qty: Number(qty),
      systemQty: systemQty === null ? null : Number(systemQty),
      unitPricePaise: Number(unitPricePaise),
      systemUnitPricePaise: Number(systemUnitPricePaise),

      hsnCode,
      gstRatePercent,
      taxableAmountPaise,
      taxPaise,
      lineTotalPaise: taxableAmountPaise + taxPaise,

      origin,
      syncState,
    };
  }

  /**
   * Header summary. Tax is grouped by rate rather than reduced to one number,
   * because that grouping is exactly what GSTR-1 asks for and reconstructing it
   * later from a single blended figure is impossible.
   */
  static _totals(components) {
    const billable = components.filter((c) => c.action !== 'DETACH');

    const byRate = new Map();
    for (const c of billable) {
      const bucket = byRate.get(c.gstRatePercent) || { gstRatePercent: c.gstRatePercent, taxableAmountPaise: 0, taxPaise: 0 };
      bucket.taxableAmountPaise += c.taxableAmountPaise;
      bucket.taxPaise += c.taxPaise;
      byRate.set(c.gstRatePercent, bucket);
    }

    const taxableAmountPaise = addPaise(...billable.map((c) => c.taxableAmountPaise));
    const taxPaise = addPaise(...billable.map((c) => c.taxPaise));

    return {
      taxableAmountPaise,
      taxPaise,
      componentsTotalPaise: taxableAmountPaise + taxPaise,
      taxSummary: [...byRate.values()].sort((a, b) => a.gstRatePercent - b.gstRatePercent),
    };
  }
}

module.exports = { BundleExpansionService };
