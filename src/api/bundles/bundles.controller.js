const { asyncHandler } = require('../../core/asyncHandler');
const { sendSuccess } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');
const { BundleExpansionService } = require('./bundleExpansion.service');

/** Money fields the preview introduces, masked per BR-27 like every other rate. */
const BUNDLE_RATE_FIELDS = [
  'unitPricePaise',
  'systemUnitPricePaise',
  'taxableAmountPaise',
  'taxPaise',
  'lineTotalPaise',
];

/**
 * GET /products/:id/bundle-preview
 *
 * Answers "what would this product bring with it?" without creating anything.
 * The sales screen calls it before a line exists, so it takes the quantity and
 * the commercial context as query parameters rather than reading a document.
 *
 * Read-only by construction — Phase 1 writes nothing to sales orders. The
 * service it calls is pure; this endpoint is the only thing exposing it.
 */
const previewBundle = asyncHandler(async (req, res) => {
  const { qty, factoryId, partyId, onDate, priceType } = req.query;

  const plan = await BundleExpansionService.reconcile({
    parentProductId: req.params.id,
    parentLineId: null,           // nothing exists yet; this is a quote, not a line
    newParentQty: Number(qty ?? 1),
    presentComponents: [],
    suppressedProductIds: [],
    context: { factoryId, partyId, onDate, priceType },
  });

  sendSuccess(
    res,
    {
      ...plan,
      components: maskRateFields(plan.components, req, BUNDLE_RATE_FIELDS),
      // The header summary is money too, so it goes with the rest.
      totals: maskRateFields(plan.totals, req, [
        'taxableAmountPaise', 'taxPaise', 'componentsTotalPaise', 'taxSummary',
      ]),
    },
    plan.bundleRuleId ? 'Bundle preview retrieved successfully' : 'Product has no active bundle'
  );
});

module.exports = { previewBundle };
