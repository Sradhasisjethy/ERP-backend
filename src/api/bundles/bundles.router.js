const { Router } = require('express');
const { z } = require('zod');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { enforceFactoryScope } = require('../../middlewares/factoryScope');
const { asyncHandler } = require('../../core/asyncHandler');
const { sendSuccess, sendList } = require('../../utils/response');
const { BundleRulesService, OverrideReasonCodesService } = require('./bundleRules.service');
const { BundleReportsService } = require('./bundleReports.service');
const { BundleAvailabilityService } = require('./bundleAvailability.service');

/**
 * Bundle master data and reporting.
 *
 * The order-side commands live on the sales router, because that is the
 * document they act on. This router is the back office: defining what a bundle
 * contains, curating the reasons people give for breaking it, and reading how
 * often they do.
 */

const componentSchema = z.object({
  componentProductId: z.string().uuid(),
  quantity: z.coerce.number().positive(),
  scalingMode: z.enum(['PROPORTIONAL', 'FIXED']).optional(),
  // Optional: the server takes the product's own unit, and rejects any other.
  uomId: z.string().uuid().optional(),
  isMandatory: z.boolean().optional(),
  defaultSelected: z.boolean().optional(),
  sequence: z.coerce.number().int().optional(),
});

const createRuleSchema = z.object({
  body: z.object({
    code: z.string().trim().min(2).max(50),
    name: z.string().trim().min(2).max(200),
    parentProductId: z.string().uuid(),
    effectiveFrom: z.string().trim().min(1),
    priority: z.coerce.number().int().optional(),
    bundleType: z.enum(['EXPLODED', 'ASSEMBLED']).optional(),
    taxTreatment: z.enum(['INDEPENDENT', 'COMPOSITE', 'MIXED']).optional(),
    components: z.array(componentSchema).min(1),
  }),
});

const updateRuleSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2).max(200).optional(),
    parentProductId: z.string().uuid().optional(),
    effectiveFrom: z.string().trim().min(1).optional(),
    priority: z.coerce.number().int().optional(),
    bundleType: z.enum(['EXPLODED', 'ASSEMBLED']).optional(),
    taxTreatment: z.enum(['INDEPENDENT', 'COMPOSITE', 'MIXED']).optional(),
    components: z.array(componentSchema).min(1).optional(),
  }),
});

const publishSchema = z.object({
  body: z.object({ effectiveFrom: z.string().trim().min(1).optional() }).optional(),
});

const listRulesQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  parentProductId: z.string().uuid().optional(),
  status: z.enum(['DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED']).optional(),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
});

const reasonSchema = z.object({
  body: z.object({
    code: z.string().trim().min(2).max(50),
    label: z.string().trim().min(2).max(200),
    requiresNote: z.boolean().optional(),
  }),
});

const attachRateQuerySchema = z.object({
  groupBy: z.enum(['product', 'salesperson', 'location']).default('product'),
  fromDate: z.string().trim().min(1),
  toDate: z.string().trim().min(1),
  factoryId: z.string().uuid().optional(),
  parentProductId: z.string().uuid().optional(),
});

const bundleAtpQuerySchema = z.object({
  factoryId: z.string().uuid(),
  onDate: z.string().trim().min(1).optional(),
});

const bundlesRouter = Router();
bundlesRouter.use(authenticate, tenantScope, auditContext);

// ---- rules ---------------------------------------------------------------
//
// Gated on PRODUCT_* rather than SALES_*: a bundle is a statement about what a
// product is, and the people who maintain the catalogue are the ones who should
// define it.

bundlesRouter.get('/rules', authorize('PRODUCT_READ'), validate(listRulesQuerySchema, 'query'), asyncHandler(async (req, res) => {
  const { page, limit, ...filters } = req.query;
  sendList(res, req, await BundleRulesService.list(Number(page), Number(limit), filters), 'Bundle rules retrieved successfully');
}));

bundlesRouter.get('/rules/:id', authorize('PRODUCT_READ'), asyncHandler(async (req, res) => {
  sendSuccess(res, await BundleRulesService.get(req.params.id), 'Bundle rule retrieved successfully');
}));

bundlesRouter.post('/rules', authorize('PRODUCT_CREATE'), validate(createRuleSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await BundleRulesService.create(req.body), 'Bundle rule created as a draft', 201);
}));

bundlesRouter.put('/rules/:id', authorize('PRODUCT_MODIFY'), validate(updateRuleSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await BundleRulesService.update(req.params.id, req.body), 'Bundle rule updated successfully');
}));

bundlesRouter.post('/rules/:id/publish', authorize('PRODUCT_MODIFY'), validate(publishSchema), asyncHandler(async (req, res) => {
  const rule = await BundleRulesService.publish(req.params.id, {
    effectiveFrom: req.body?.effectiveFrom,
    publishedBy: req.user?.id,
  });
  sendSuccess(res, rule, 'Bundle rule published. Orders already raised keep the version they were quoted from.');
}));

bundlesRouter.post('/rules/:id/new-version', authorize('PRODUCT_CREATE'), asyncHandler(async (req, res) => {
  sendSuccess(res, await BundleRulesService.newVersion(req.params.id), 'Draft version created', 201);
}));

bundlesRouter.delete('/rules/:id', authorize('PRODUCT_DELETE'), asyncHandler(async (req, res) => {
  sendSuccess(res, await BundleRulesService.archive(req.params.id), 'Bundle rule archived successfully');
}));

// ---- reason codes --------------------------------------------------------

bundlesRouter.get('/reason-codes', authorize('SALES_READ'), asyncHandler(async (req, res) => {
  sendSuccess(res, await OverrideReasonCodesService.list({ includeInactive: req.query.includeInactive === 'true' }), 'Reason codes retrieved successfully');
}));

bundlesRouter.post('/reason-codes', authorize('PRODUCT_CREATE'), validate(reasonSchema), asyncHandler(async (req, res) => {
  sendSuccess(res, await OverrideReasonCodesService.create(req.body), 'Reason code created successfully', 201);
}));

bundlesRouter.put('/reason-codes/:code', authorize('PRODUCT_MODIFY'), asyncHandler(async (req, res) => {
  sendSuccess(res, await OverrideReasonCodesService.update(req.params.code, req.body), 'Reason code updated successfully');
}));

bundlesRouter.delete('/reason-codes/:code', authorize('PRODUCT_DELETE'), asyncHandler(async (req, res) => {
  sendSuccess(res, await OverrideReasonCodesService.deactivate(req.params.code), 'Reason code deactivated successfully');
}));

// ---- reporting -----------------------------------------------------------
//
// enforceFactoryScope so a manager at one plant cannot read another plant's
// attach rate by naming its id (BR-29).

bundlesRouter.get('/reports/attach-rate', authorize('ANALYTICS_READ'), enforceFactoryScope, validate(attachRateQuerySchema, 'query'), asyncHandler(async (req, res) => {
  sendSuccess(res, await BundleReportsService.attachRate(req.query), 'Attach rate retrieved successfully');
}));

bundlesRouter.get('/orders/:salesOrderId/override-history', authorize('SALES_READ'), asyncHandler(async (req, res) => {
  sendSuccess(res, await BundleReportsService.overrideHistory(req.params.salesOrderId), 'Override history retrieved successfully');
}));

// ---- available to promise ------------------------------------------------

bundlesRouter.get(
  '/products/:productId/available-bundles',
  authorize('SALES_READ'),
  enforceFactoryScope,
  validate(bundleAtpQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const data = await BundleAvailabilityService.availableBundles(req.params.productId, req.query);
    sendSuccess(res, data, 'Available bundles retrieved successfully');
  })
);

module.exports = { bundlesRouter };
