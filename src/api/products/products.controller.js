const { asyncHandler } = require('../../core/asyncHandler');
const { ProductsService } = require('./products.service');
const { BomService } = require('./bom.service');
const { UomService } = require('./uom.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

// UoM
const listUoms = asyncHandler(async (req, res) => {
  const { page, limit, search, status, sortBy, sortDir } = req.query;
  const data = await ProductsService.listUoms(Number(page), Number(limit), search, status, { sortBy, sortDir });
  sendList(res, req, data, 'UoMs retrieved successfully');
});
const getUom = asyncHandler(async (req, res) => {
  sendSuccess(res, await ProductsService.getUom(req.params.id), 'UoM retrieved successfully');
});
const createUom = asyncHandler(async (req, res) => {
  sendSuccess(res, await ProductsService.createUom(req.body), 'UoM created successfully', 201);
});
const updateUom = asyncHandler(async (req, res) => {
  sendSuccess(res, await ProductsService.updateUom(req.params.id, req.body), 'UoM updated successfully');
});
const deleteUom = asyncHandler(async (req, res) => {
  await ProductsService.deleteUom(req.params.id);
  sendSuccess(res, null, 'UoM deleted successfully');
});

// Product Category
const listProductCategories = asyncHandler(async (req, res) => {
  const { page, limit, search, status, sortBy, sortDir } = req.query;
  const data = await ProductsService.listProductCategories(Number(page), Number(limit), search, status, { sortBy, sortDir });
  sendList(res, req, data, 'Product categories retrieved successfully');
});
const getProductCategory = asyncHandler(async (req, res) => {
  sendSuccess(res, await ProductsService.getProductCategory(req.params.id), 'Product category retrieved successfully');
});
const createProductCategory = asyncHandler(async (req, res) => {
  sendSuccess(res, await ProductsService.createProductCategory(req.body), 'Product category created successfully', 201);
});
const updateProductCategory = asyncHandler(async (req, res) => {
  sendSuccess(res, await ProductsService.updateProductCategory(req.params.id, req.body), 'Product category updated successfully');
});
const deleteProductCategory = asyncHandler(async (req, res) => {
  await ProductsService.deleteProductCategory(req.params.id);
  sendSuccess(res, null, 'Product category deleted successfully');
});

// HSN Code
const listHsnCodes = asyncHandler(async (req, res) => {
  const { page, limit, search, status, sortBy, sortDir } = req.query;
  const data = await ProductsService.listHsnCodes(Number(page), Number(limit), search, status, { sortBy, sortDir });
  sendList(res, req, data, 'HSN codes retrieved successfully');
});
const getHsnCode = asyncHandler(async (req, res) => {
  sendSuccess(res, await ProductsService.getHsnCode(req.params.id), 'HSN code retrieved successfully');
});
const createHsnCode = asyncHandler(async (req, res) => {
  sendSuccess(res, await ProductsService.createHsnCode(req.body), 'HSN code created successfully', 201);
});
const updateHsnCode = asyncHandler(async (req, res) => {
  sendSuccess(res, await ProductsService.updateHsnCode(req.params.id, req.body), 'HSN code updated successfully');
});
const deleteHsnCode = asyncHandler(async (req, res) => {
  await ProductsService.deleteHsnCode(req.params.id);
  sendSuccess(res, null, 'HSN code deleted successfully');
});

// Product — standardCostPaise is masked per BR-27 for users without VIEW_RATES.
const listProducts = asyncHandler(async (req, res) => {
  const { page, limit, search, status, categoryId, productType, sortBy, sortDir } = req.query;
  const data = await ProductsService.listProducts(Number(page), Number(limit), { search, status, categoryId, productType, sortBy, sortDir });
  sendList(res, req, maskRateFields(data, req), 'Products retrieved successfully');
});
const getProduct = asyncHandler(async (req, res) => {
  const data = await ProductsService.getProduct(req.params.id);
  sendSuccess(res, maskRateFields(data, req), 'Product retrieved successfully');
});
const createProduct = asyncHandler(async (req, res) => {
  sendSuccess(res, await ProductsService.createProduct(req.body), 'Product created successfully', 201);
});
const updateProduct = asyncHandler(async (req, res) => {
  sendSuccess(res, await ProductsService.updateProduct(req.params.id, req.body), 'Product updated successfully');
});
const deleteProduct = asyncHandler(async (req, res) => {
  await ProductsService.deleteProduct(req.params.id);
  sendSuccess(res, null, 'Product deleted successfully');
});

// Mix Design (BOM)
const listMixDesigns = asyncHandler(async (req, res) => {
  const { page, limit, productId, search, status, sortBy, sortDir } = req.query;
  const data = await BomService.list(Number(page), Number(limit), { productId, search, status, sortBy, sortDir });
  sendList(res, req, data, 'Mix designs retrieved successfully');
});
const getMixDesign = asyncHandler(async (req, res) => {
  sendSuccess(res, await BomService.get(req.params.id), 'Mix design retrieved successfully');
});
const createMixDesign = asyncHandler(async (req, res) => {
  sendSuccess(res, await BomService.create(req.body), 'Mix design created successfully', 201);
});
const updateMixDesign = asyncHandler(async (req, res) => {
  sendSuccess(res, await BomService.update(req.params.id, req.body), 'Mix design updated successfully');
});
const activateMixDesign = asyncHandler(async (req, res) => {
  sendSuccess(res, await BomService.activate(req.params.id, req.body), 'Mix design activated successfully');
});
const deleteMixDesign = asyncHandler(async (req, res) => {
  await BomService.remove(req.params.id);
  sendSuccess(res, null, 'Mix design deleted successfully');
});

// --- BOM extras (FR-M03-8/9/10/11) ---
const cloneMixDesign = asyncHandler(async (req, res) => {
  sendSuccess(res, await BomService.cloneAsDraft(req.params.id, req.body), 'Mix design cloned as a new draft', 201);
});
const resolveMixDesign = asyncHandler(async (req, res) => {
  const { BomService } = require('./bom.service');
  const data = await BomService.resolveForDate(req.query.productId, req.query.onDate);
  sendSuccess(res, data, 'Mix design resolved successfully');
});
const explodeMixDesign = asyncHandler(async (req, res) => {
  sendSuccess(res, await BomService.explode(req.params.id, req.query.outputQty || 1), 'Mix design exploded successfully');
});
const mixDesignCost = asyncHandler(async (req, res) => {
  const data = await BomService.costRollup(req.params.id);
  // BR-27: a cost rollup is money end to end.
  sendSuccess(res, maskRateFields(data, req, ['totalCostPaise']), 'Mix design cost retrieved successfully');
});

// --- UoM conversions (FR-M03-2) ---
const listUomConversions = asyncHandler(async (req, res) => {
  const { page, limit, search, status, sortBy, sortDir } = req.query;
  sendList(res, req, await UomService.list(Number(page), Number(limit), { search, status, sortBy, sortDir }), 'UoM conversions retrieved successfully');
});
const createUomConversion = asyncHandler(async (req, res) => {
  sendSuccess(res, await UomService.create(req.body), 'UoM conversion created successfully', 201);
});
const updateUomConversion = asyncHandler(async (req, res) => {
  sendSuccess(res, await UomService.update(req.params.id, req.body), 'UoM conversion updated successfully');
});
const deleteUomConversion = asyncHandler(async (req, res) => {
  await UomService.remove(req.params.id);
  sendSuccess(res, null, 'UoM conversion deleted successfully');
});
const convertUom = asyncHandler(async (req, res) => {
  const { quantity, fromUomId, toUomId } = req.query;
  const converted = await UomService.convert(quantity, fromUomId, toUomId);
  sendSuccess(res, { quantity: Number(quantity), fromUomId, toUomId, converted }, 'Quantity converted successfully');
});

module.exports = {
  cloneMixDesign, explodeMixDesign, resolveMixDesign, mixDesignCost,
  listUomConversions, createUomConversion, updateUomConversion, deleteUomConversion, convertUom,
  listUoms, getUom, createUom, updateUom, deleteUom,
  listProductCategories, getProductCategory, createProductCategory, updateProductCategory, deleteProductCategory,
  listHsnCodes, getHsnCode, createHsnCode, updateHsnCode, deleteHsnCode,
  listProducts, getProduct, createProduct, updateProduct, deleteProduct,
  listMixDesigns, getMixDesign, createMixDesign, updateMixDesign, activateMixDesign, deleteMixDesign,
};
