const { asyncHandler } = require('../../core/asyncHandler');
const { PricingService } = require('./pricing.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

const listPriceLists = asyncHandler(async (req, res) => {
  const { page, limit, search, status, priceType, partyId } = req.query;
  const data = await PricingService.listPriceLists(Number(page), Number(limit), { search, status, priceType, partyId });
  sendList(res, req, data, 'Price lists retrieved successfully');
});

const getPriceList = asyncHandler(async (req, res) => {
  const priceList = await PricingService.getPriceList(req.params.id);
  const plain = priceList.toJSON();
  plain.items = maskRateFields(plain.items, req);
  sendSuccess(res, plain, 'Price list retrieved successfully');
});

const createPriceList = asyncHandler(async (req, res) => {
  const data = await PricingService.createPriceList(req.body);
  sendSuccess(res, data, 'Price list created successfully', 201);
});

const updatePriceList = asyncHandler(async (req, res) => {
  const data = await PricingService.updatePriceList(req.params.id, req.body);
  sendSuccess(res, data, 'Price list updated successfully');
});

const deletePriceList = asyncHandler(async (req, res) => {
  await PricingService.deletePriceList(req.params.id);
  sendSuccess(res, null, 'Price list deleted successfully');
});

const upsertItem = asyncHandler(async (req, res) => {
  const data = await PricingService.upsertItem(req.params.id, req.body);
  sendSuccess(res, data, 'Price list item saved successfully');
});

const removeItem = asyncHandler(async (req, res) => {
  await PricingService.removeItem(req.params.id, req.params.productId);
  sendSuccess(res, null, 'Price list item removed successfully');
});

module.exports = { listPriceLists, getPriceList, createPriceList, updatePriceList, deletePriceList, upsertItem, removeItem };
