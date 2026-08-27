const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const {
  listLots, listLedgerEntries, getStockBalance, releaseLotEarly, listAdjustments, createAdjustment,
  listReservations,
} = require('./inventory.controller');
const {
  listLotsQuerySchema, listLedgerQuerySchema, balanceQuerySchema, releaseEarlySchema,
  listAdjustmentsQuerySchema, createAdjustmentSchema, listReservationsQuerySchema,
} = require('./inventory.schema');

const inventoryRouter = Router();

inventoryRouter.use(authenticate, tenantScope, auditContext);

inventoryRouter.get('/lots', authorize('INVENTORY_READ'), validate(listLotsQuerySchema, 'query'), listLots);
inventoryRouter.get('/ledger', authorize('INVENTORY_READ'), validate(listLedgerQuerySchema, 'query'), listLedgerEntries);
inventoryRouter.get('/balance', authorize('INVENTORY_READ'), validate(balanceQuerySchema, 'query'), getStockBalance);
// M07: the holds themselves. The service has driven sales promising since it
// was written; nothing ever exposed what it was holding.
inventoryRouter.get('/reservations', authorize('INVENTORY_READ'), validate(listReservationsQuerySchema, 'query'), listReservations);

inventoryRouter.put('/lots/:id/release-early', authorize('OVERRIDE_CURING'), validate(releaseEarlySchema), releaseLotEarly);

// M22: a physical count correction writes stock without a business document
// behind it, so it takes INVENTORY_CREATE — reading stock is not enough.
inventoryRouter.get('/adjustments', authorize('INVENTORY_READ'), validate(listAdjustmentsQuerySchema, 'query'), listAdjustments);
inventoryRouter.post('/adjustments', authorize('INVENTORY_CREATE'), validate(createAdjustmentSchema), createAdjustment);

module.exports = { inventoryRouter };
