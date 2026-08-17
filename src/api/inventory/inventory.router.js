const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const { listLots, listLedgerEntries, getStockBalance, releaseLotEarly } = require('./inventory.controller');
const { listLotsQuerySchema, listLedgerQuerySchema, balanceQuerySchema, releaseEarlySchema } = require('./inventory.schema');

const inventoryRouter = Router();

inventoryRouter.use(authenticate, tenantScope, auditContext);

inventoryRouter.get('/lots', authorize('INVENTORY_READ'), validate(listLotsQuerySchema, 'query'), listLots);
inventoryRouter.get('/ledger', authorize('INVENTORY_READ'), validate(listLedgerQuerySchema, 'query'), listLedgerEntries);
inventoryRouter.get('/balance', authorize('INVENTORY_READ'), validate(balanceQuerySchema, 'query'), getStockBalance);
inventoryRouter.put('/lots/:id/release-early', authorize('OVERRIDE_CURING'), validate(releaseEarlySchema), releaseLotEarly);

module.exports = { inventoryRouter };
