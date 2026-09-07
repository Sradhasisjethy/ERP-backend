const { asyncHandler } = require('../../core/asyncHandler');
const { sequelize } = require('../../config/database');
const { SalesService } = require('./sales.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');
const { hasPermission } = require('../../middlewares/authorize');
const { scopeListToFactories, assertCanUseFactory, assertCanSeeRecord } = require('../../core/salesScope');

const listSalesOrders = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, customerPartyId, status, search, sortBy, sortDir } = req.query;
  // BR-29: restrict to the factories this user may see. Without a factoryId
  // filter this used to return every location's orders.
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await SalesService.listSalesOrders(Number(page), Number(limit), {
    customerPartyId, status, search, sortBy, sortDir, baseWhere,
  });
  sendList(res, req, maskRateFields(data, req), 'Sales orders retrieved successfully');
});

const getSalesOrder = asyncHandler(async (req, res) => {
  const data = await SalesService.getSalesOrder(req.params.id);
  await assertCanSeeRecord(req, data, 'Sales order not found');
  // BR-28: PO attachments are visible only to roles explicitly granted access.
  const plain = data.toJSON();
  if (!hasPermission(req.user, 'VIEW_PO_ATTACHMENTS')) {
    plain.poAttachmentPath = null;
  }
  sendSuccess(res, maskRateFields(plain, req), 'Sales order retrieved successfully');
});

const createSalesOrder = asyncHandler(async (req, res) => {
  // BR-29: raising an order *for* a factory the user has no access to is the
  // same breach as reading one from it.
  await assertCanUseFactory(req, req.body.factoryId);
  // Only a user with SALES_CREDIT_OVERRIDE can actually exercise the override
  // they requested — everyone else's flag is silently ignored, not honoured.
  const allowCreditOverride = !!req.body.allowCreditOverride && hasPermission(req.user, 'SALES_CREDIT_OVERRIDE');
  // Leaving a mandatory accessory off at order entry is the same decision as
  // removing one afterwards, and needs the same grant.
  const canOverrideMandatory = hasPermission(req.user, 'SALES_BUNDLE_OVERRIDE_MANDATORY');
  const { order, creditWarning } = await SalesService.createSalesOrder({ ...req.body, allowCreditOverride, canOverrideMandatory });
  sendSuccess(res, { ...order.toJSON(), creditWarning }, 'Sales order created successfully', 201);
});

/** Every mutation re-checks location access before it acts. */
const guardOrder = async (req) =>
  assertCanSeeRecord(req, await SalesService.getSalesOrder(req.params.id), 'Sales order not found');

const updateSalesOrder = asyncHandler(async (req, res) => {
  await guardOrder(req);
  const allowCreditOverride = !!req.body.allowCreditOverride && hasPermission(req.user, 'SALES_CREDIT_OVERRIDE');
  const canOverrideMandatory = hasPermission(req.user, 'SALES_BUNDLE_OVERRIDE_MANDATORY');
  const data = await SalesService.updateSalesOrder(req.params.id, { ...req.body, allowCreditOverride, canOverrideMandatory });
  sendSuccess(res, maskRateFields(data, req), 'Sales order updated successfully');
});

const markInProduction = asyncHandler(async (req, res) => {
  await guardOrder(req);
  const data = await SalesService.markInProduction(req.params.id);
  sendSuccess(res, maskRateFields(data, req), 'Sales order marked as in production');
});

const confirmSalesOrder = asyncHandler(async (req, res) => {
  await guardOrder(req);
  const data = await SalesService.confirmSalesOrder(req.params.id);
  sendSuccess(res, data, 'Sales order confirmed successfully');
});

const cancelSalesOrder = asyncHandler(async (req, res) => {
  await guardOrder(req);
  const data = await SalesService.cancelSalesOrder(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Sales order cancelled successfully');
});

const shortCloseSalesOrder = asyncHandler(async (req, res) => {
  await guardOrder(req);
  const data = await SalesService.shortCloseSalesOrder(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Sales order short-closed successfully');
});

const getAvailableToPromise = asyncHandler(async (req, res) => {
  const { factoryId, productId } = req.query;
  await assertCanUseFactory(req, factoryId);
  const atp = await sequelize.transaction((t) => SalesService.getAvailableToPromise(factoryId, productId, t));
  // The order screen needs the whole breakdown (FR-M06-3), not just one number:
  // showing "available 30" without "curing 25" is what leads a salesperson to
  // promise stock that legally cannot ship yet.
  sendSuccess(
    res,
    { factoryId, productId, ...atp, availableToPromise: atp.available },
    'Available-to-promise retrieved successfully'
  );
});

module.exports = {
  listSalesOrders, getSalesOrder, createSalesOrder, updateSalesOrder, markInProduction,
  confirmSalesOrder, cancelSalesOrder, shortCloseSalesOrder, getAvailableToPromise,
};
