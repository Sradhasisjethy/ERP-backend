const { asyncHandler } = require('../../core/asyncHandler');
const { sendSuccess } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');
const { hasPermission } = require('../../middlewares/authorize');
const { assertCanSeeRecord } = require('../../core/salesScope');
const { SalesService } = require('../sales/sales.service');
const { SalesOrderLine } = require('../sales/salesOrderLine.model');
const { BundleDocumentService } = require('./bundleDocument.service');
const { NotFoundError } = require('../../core/AppError');

/**
 * Bundle commands on a sales order. See docs/specs/bundle-kitting.md §6.
 *
 * Commands, not CRUD. A generic line PATCH would put the orchestration in the
 * frontend, and the frontend would then be a second place where expansion
 * rules live — which is exactly what invariant 1 forbids.
 *
 * Every one of these answers with the whole order plus any warnings, so the
 * client never has to stitch a response together or re-fetch to find out what
 * else moved.
 */

const RATE_FIELDS = ['ratePaise', 'systemUnitPricePaise', 'totalAmountPaise'];

/** The response envelope every mutating bundle endpoint returns (§6). */
const respond = async (req, res, orderId, warnings = [], message) => {
  const order = await SalesService.getSalesOrder(orderId);

  const plain = order.toJSON();
  // BR-28, matching the behaviour of GET /sales/orders/:id.
  if (!hasPermission(req.user, 'VIEW_PO_ATTACHMENTS')) delete plain.poAttachmentUrl;

  sendSuccess(res, { order: maskRateFields(plain, req, RATE_FIELDS), warnings }, message);
};

/**
 * Loads a line and proves the caller is allowed to touch the order it sits on.
 *
 * BR-29 is enforced on the *order*, not the line: a line id alone would let a
 * user at one plant edit another plant's order by guessing an id.
 */
const loadLine = async (req, lineId, orderId) => {
  const line = await SalesOrderLine.findByPk(lineId);
  if (!line || line.salesOrderId !== orderId) throw new NotFoundError('That order line is not on this order');

  const order = await SalesService.getSalesOrder(orderId);
  await assertCanSeeRecord(req, order, 'Sales order not found');

  return line;
};

/** POST /sales/orders/:id/lines — add a product; its accessories follow. */
const addLine = asyncHandler(async (req, res) => {
  const order = await SalesService.getSalesOrder(req.params.id);
  await assertCanSeeRecord(req, order, 'Sales order not found');

  const { warnings } = await SalesService.addLine(req.params.id, req.body);
  await respond(req, res, req.params.id, warnings, 'Line added successfully');
});

/**
 * PATCH /sales/orders/:id/lines/:lineId/quantity
 *
 * One endpoint for both roles on purpose. Changing a parent rescales its
 * accessories; changing an accessory means the user has taken ownership of that
 * number and expansion stops touching it. The caller should not have to know
 * which kind of line it is holding.
 */
const changeQuantity = asyncHandler(async (req, res) => {
  const line = await loadLine(req, req.params.lineId, req.params.id);

  const result =
    line.lineRole === 'COMPONENT'
      ? await BundleDocumentService.changeComponentQty(line.parentLineId, line.productId, req.body.qty)
      : await BundleDocumentService.changeParentQty(line.id, req.body.qty);

  await respond(req, res, req.params.id, result.warnings, 'Quantity updated successfully');
});

/** POST /sales/orders/:id/lines/:lineId/suppress — take an accessory off. */
const suppress = asyncHandler(async (req, res) => {
  const line = await loadLine(req, req.params.lineId, req.params.id);

  await BundleDocumentService.suppress(line.parentLineId, line.productId, {
    reasonCode: req.body.reasonCode,
    reasonNote: req.body.reasonNote,
    // The permission is read here rather than gated on the route: without it
    // the request is still valid for every non-mandatory component, so a route
    // gate would refuse far more than the rule intends.
    canOverrideMandatory: hasPermission(req.user, 'SALES_BUNDLE_OVERRIDE_MANDATORY'),
  });

  await respond(req, res, req.params.id, [], 'Item removed from the line');
});

/** POST /sales/orders/:id/lines/:parentLineId/restore */
const restore = asyncHandler(async (req, res) => {
  const parent = await loadLine(req, req.params.parentLineId, req.params.id);
  const result = await BundleDocumentService.restore(parent.id, req.body.componentProductId);
  await respond(req, res, req.params.id, result.warnings, 'Item restored to the line');
});

/** POST /sales/orders/:id/lines/:parentLineId/components — add an optional extra. */
const addComponent = asyncHandler(async (req, res) => {
  const parent = await loadLine(req, req.params.parentLineId, req.params.id);
  await BundleDocumentService.addOptional(parent.id, req.body.productId, { qty: req.body.qty });
  await respond(req, res, req.params.id, [], 'Accessory added successfully');
});

/** POST /sales/orders/:id/lines/:lineId/reset — hand the line back to the system. */
const resetLine = asyncHandler(async (req, res) => {
  const line = await loadLine(req, req.params.lineId, req.params.id);
  const result = await BundleDocumentService.resetComponent(line.parentLineId, line.productId);
  await respond(req, res, req.params.id, result.warnings, 'Line reset to the suggested values');
});

/** DELETE /sales/orders/:id/lines/:lineId — a parent takes its group with it. */
const deleteLine = asyncHandler(async (req, res) => {
  const line = await loadLine(req, req.params.lineId, req.params.id);
  await BundleDocumentService.deleteParentLine(line.id);
  await respond(req, res, req.params.id, [], 'Line removed successfully');
});

/** GET /sales/orders/:id/lines/:parentLineId/available-accessories */
const availableAccessories = asyncHandler(async (req, res) => {
  const parent = await loadLine(req, req.params.parentLineId, req.params.id);
  const data = await BundleDocumentService.availableAccessories(parent.id);
  sendSuccess(res, data, 'Available accessories retrieved successfully');
});

module.exports = {
  addLine,
  changeQuantity,
  suppress,
  restore,
  addComponent,
  resetLine,
  deleteLine,
  availableAccessories,
};
