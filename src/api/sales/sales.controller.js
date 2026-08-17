const { asyncHandler } = require('../../core/asyncHandler');
const { sequelize } = require('../../config/database');
const { SalesService } = require('./sales.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');
const { hasPermission } = require('../../middlewares/authorize');

const listSalesOrders = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, customerPartyId, status, search } = req.query;
  const data = await SalesService.listSalesOrders(Number(page), Number(limit), { factoryId, customerPartyId, status, search });
  sendList(res, req, maskRateFields(data, req), 'Sales orders retrieved successfully');
});

const getSalesOrder = asyncHandler(async (req, res) => {
  const data = await SalesService.getSalesOrder(req.params.id);
  // BR-28: PO attachments are visible only to roles explicitly granted access.
  const plain = data.toJSON();
  if (!hasPermission(req.user, 'VIEW_PO_ATTACHMENTS')) {
    plain.poAttachmentPath = null;
  }
  sendSuccess(res, maskRateFields(plain, req), 'Sales order retrieved successfully');
});

const createSalesOrder = asyncHandler(async (req, res) => {
  // Only a user with SALES_CREDIT_OVERRIDE can actually exercise the override
  // they requested — everyone else's flag is silently ignored, not honoured.
  const allowCreditOverride = !!req.body.allowCreditOverride && hasPermission(req.user, 'SALES_CREDIT_OVERRIDE');
  const { order, creditWarning } = await SalesService.createSalesOrder({ ...req.body, allowCreditOverride });
  sendSuccess(res, { ...order.toJSON(), creditWarning }, 'Sales order created successfully', 201);
});

const confirmSalesOrder = asyncHandler(async (req, res) => {
  const data = await SalesService.confirmSalesOrder(req.params.id);
  sendSuccess(res, data, 'Sales order confirmed successfully');
});

const cancelSalesOrder = asyncHandler(async (req, res) => {
  const data = await SalesService.cancelSalesOrder(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Sales order cancelled successfully');
});

const shortCloseSalesOrder = asyncHandler(async (req, res) => {
  const data = await SalesService.shortCloseSalesOrder(req.params.id, req.body.reason);
  sendSuccess(res, data, 'Sales order short-closed successfully');
});

const getAvailableToPromise = asyncHandler(async (req, res) => {
  const { factoryId, productId } = req.query;
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
  listSalesOrders, getSalesOrder, createSalesOrder, confirmSalesOrder, cancelSalesOrder, shortCloseSalesOrder, getAvailableToPromise,
};
