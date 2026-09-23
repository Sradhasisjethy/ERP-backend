const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { enforceFactoryScope } = require('../../middlewares/factoryScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const controller = require('./fixedAssets.controller');
const schema = require('./fixedAssets.schema');

const fixedAssetsRouter = Router();

fixedAssetsRouter.use(authenticate, tenantScope, auditContext, enforceFactoryScope);

// Fixed paths before /:id.
fixedAssetsRouter.get('/depreciation/preview', authorize('FIXED_ASSET_READ'), validate(schema.previewQuerySchema, 'query'), controller.preview);
fixedAssetsRouter.get('/depreciation/runs', authorize('FIXED_ASSET_READ'), validate(schema.runListQuerySchema, 'query'), controller.listRuns);
fixedAssetsRouter.post('/depreciation/runs', authorize('FIXED_ASSET_CREATE'), validate(schema.runSchema), controller.run);
fixedAssetsRouter.put('/depreciation/runs/:id/cancel', authorize('FIXED_ASSET_MODIFY'), validate(schema.cancelRunSchema), controller.cancelRun);

fixedAssetsRouter.get('/', authorize('FIXED_ASSET_READ'), validate(schema.listQuerySchema, 'query'), controller.list);
fixedAssetsRouter.post('/', authorize('FIXED_ASSET_CREATE'), validate(schema.createAssetSchema), controller.create);
fixedAssetsRouter.get('/:id', authorize('FIXED_ASSET_READ'), controller.get);
fixedAssetsRouter.put('/:id', authorize('FIXED_ASSET_MODIFY'), validate(schema.updateAssetSchema), controller.update);
fixedAssetsRouter.put('/:id/dispose', authorize('FIXED_ASSET_MODIFY'), validate(schema.disposeSchema), controller.dispose);

module.exports = { fixedAssetsRouter };
