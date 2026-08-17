const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { authorize } = require('../../middlewares/authorize');
const { validate } = require('../../middlewares/validate');
const {
  listParties,
  getParty,
  createParty,
  updateParty,
  deleteParty,
  upsertWageProfile,
  listAddresses,
  createAddress,
  updateAddress,
  deleteAddress,
} = require('./parties.controller');
const { createPartySchema, updatePartySchema, upsertLabourWageProfileSchema, listQuerySchema, createAddressSchema, updateAddressSchema } = require('./parties.schema');

const partiesRouter = Router();

partiesRouter.use(authenticate, tenantScope, auditContext);

partiesRouter.get('/', authorize('PARTY_READ'), validate(listQuerySchema, 'query'), listParties);
partiesRouter.post('/', authorize('PARTY_CREATE'), validate(createPartySchema), createParty);
partiesRouter.get('/:id', authorize('PARTY_READ'), getParty);
partiesRouter.put('/:id', authorize('PARTY_MODIFY'), validate(updatePartySchema), updateParty);
partiesRouter.delete('/:id', authorize('PARTY_DELETE'), deleteParty);

partiesRouter.put('/:id/wage-profile', authorize('PARTY_MODIFY'), validate(upsertLabourWageProfileSchema), upsertWageProfile);

// FR-M04-2: addresses nested under their party.
partiesRouter.get('/:id/addresses', authorize('PARTY_READ'), listAddresses);
partiesRouter.post('/:id/addresses', authorize('PARTY_CREATE'), validate(createAddressSchema), createAddress);
partiesRouter.put('/:id/addresses/:addressId', authorize('PARTY_MODIFY'), validate(updateAddressSchema), updateAddress);
partiesRouter.delete('/:id/addresses/:addressId', authorize('PARTY_DELETE'), deleteAddress);

module.exports = { partiesRouter };
