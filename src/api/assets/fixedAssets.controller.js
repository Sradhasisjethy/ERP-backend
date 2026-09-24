const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories, assertCanUseFactory, assertCanSeeRecord } = require('../../core/salesScope');
const { FixedAssetsService } = require('./fixedAssets.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');


const list = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, status, category, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await FixedAssetsService.list(Number(page), Number(limit), { status, category, search, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Assets retrieved successfully');
});

const get = asyncHandler(async (req, res) => {
  const asset = await FixedAssetsService.getView(req.params.id);
  await assertCanSeeRecord(req, asset, 'Asset not found');
  sendSuccess(res, maskRateFields(asset, req), 'Asset retrieved successfully');
});

const create = asyncHandler(async (req, res) => {
  await assertCanUseFactory(req, req.body.factoryId);
  sendSuccess(res, maskRateFields(await FixedAssetsService.create(req.body), req), 'Asset registered', 201);
});

const update = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await FixedAssetsService.getView(req.params.id), 'Asset not found');
  sendSuccess(res, maskRateFields(await FixedAssetsService.update(req.params.id, req.body), req), 'Asset updated');
});

const dispose = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await FixedAssetsService.getView(req.params.id), 'Asset not found');
  sendSuccess(res, maskRateFields(await FixedAssetsService.dispose(req.params.id, req.body), req), 'Asset disposed');
});

const preview = asyncHandler(async (req, res) => {
  await assertCanUseFactory(req, req.query.factoryId);
  const data = await FixedAssetsService.previewDepreciation(req.query);
  sendSuccess(
    res,
    { ...maskRateFields(data, req), lines: maskRateFields(data.lines, req) },
    'Depreciation preview'
  );
});

const run = asyncHandler(async (req, res) => {
  await assertCanUseFactory(req, req.body.factoryId);
  sendSuccess(res, maskRateFields(await FixedAssetsService.runDepreciation(req.body), req), 'Depreciation posted', 201);
});

const listRuns = asyncHandler(async (req, res) => {
  const { page, limit, factoryId } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await FixedAssetsService.listRuns(Number(page), Number(limit), { baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Depreciation runs retrieved');
});

const cancelRun = asyncHandler(async (req, res) => {
  // BR-29: undoing another location's depreciation is the same breach as reading it.
  await assertCanSeeRecord(req, await FixedAssetsService.getRun(req.params.id), 'Depreciation run not found');
  sendSuccess(res, maskRateFields(await FixedAssetsService.cancelRun(req.params.id, req.body.reason), req), 'Depreciation run cancelled');
});

module.exports = { list, get, create, update, dispose, preview, run, listRuns, cancelRun };
