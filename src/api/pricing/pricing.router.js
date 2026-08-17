const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const {
  listPriceLists,
  getPriceList,
  createPriceList,
  updatePriceList,
  deletePriceList,
  upsertItem,
  removeItem,
} = require('./pricing.controller');
const {
  createPriceListSchema,
  updatePriceListSchema,
  upsertPriceListItemSchema,
  listQuerySchema,
} = require('./pricing.schema');

const pricingRouter = Router();

pricingRouter.use(authenticate, tenantScope, auditContext);

pricingRouter.get('/', authorize('PRICING_READ'), validate(listQuerySchema, 'query'), listPriceLists);
pricingRouter.post('/', authorize('PRICING_CREATE'), validate(createPriceListSchema), createPriceList);
pricingRouter.get('/:id', authorize('PRICING_READ'), getPriceList);
pricingRouter.put('/:id', authorize('PRICING_MODIFY'), validate(updatePriceListSchema), updatePriceList);
pricingRouter.delete('/:id', authorize('PRICING_DELETE'), deletePriceList);

pricingRouter.put('/:id/items', authorize('PRICING_MODIFY'), validate(upsertPriceListItemSchema), upsertItem);
pricingRouter.delete('/:id/items/:productId', authorize('PRICING_DELETE'), removeItem);

module.exports = { pricingRouter };
