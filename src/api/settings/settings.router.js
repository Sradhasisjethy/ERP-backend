const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { listSettings, getSetting, upsertSetting, deleteSetting } = require('./settings.controller');
const { updateSettingSchema, createSettingSchema, listSettingsQuerySchema } = require('./settings.schema');

const settingsRouter = Router();

settingsRouter.use(authenticate, tenantScope);

settingsRouter.get('/', authorize('SETTINGS_READ'), validate(listSettingsQuerySchema, 'query'), listSettings);
settingsRouter.post('/', authorize('SETTINGS_CREATE'), validate(createSettingSchema), upsertSetting);
settingsRouter.get('/:key', authorize('SETTINGS_READ'), getSetting);
settingsRouter.put('/:key', authorize('SETTINGS_MODIFY'), validate(updateSettingSchema), upsertSetting);
settingsRouter.delete('/:key', authorize('SETTINGS_DELETE'), deleteSetting);

module.exports = { settingsRouter };
