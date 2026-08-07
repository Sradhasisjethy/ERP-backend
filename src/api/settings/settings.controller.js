const { asyncHandler } = require('../../core/asyncHandler');
const { SettingsService } = require('./settings.service');
const { sendSuccess } = require('../../utils/response');

const listSettings = asyncHandler(async (req, res) => {
  const { category } = req.query;
  const data = await SettingsService.list(category);
  sendSuccess(res, data, 'Settings retrieved successfully');
});

const getSetting = asyncHandler(async (req, res) => {
  const data = await SettingsService.getByKey(req.params.key);
  sendSuccess(res, data, 'Setting retrieved successfully');
});

const upsertSetting = asyncHandler(async (req, res) => {
  const { key, value, category } = req.body;
  const targetKey = req.params.key || key;
  const data = await SettingsService.upsert(targetKey, value, category);
  sendSuccess(res, data, 'Setting saved successfully');
});

const deleteSetting = asyncHandler(async (req, res) => {
  await SettingsService.delete(req.params.key);
  sendSuccess(res, null, 'Setting deleted successfully');
});

module.exports = { listSettings, getSetting, upsertSetting, deleteSetting };
