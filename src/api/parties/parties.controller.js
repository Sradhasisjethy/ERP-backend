const { asyncHandler } = require('../../core/asyncHandler');
const { PartiesService } = require('./parties.service');
const { PartyAddressService } = require('./partyAddress.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');
const { maskSensitiveFields, canViewSensitive } = require('./partySensitive');

// Every party this controller returns goes through here: rate masking (BR-27)
// and identity/bank masking (PARTY_SENSITIVE_READ) in one step.
const present = (data, req) => maskSensitiveFields(maskRateFields(data, req), req.user);

const listParties = asyncHandler(async (req, res) => {
  const { page, limit, search, status, partyType, partyTypes, sortBy, sortDir } = req.query;
  const data = await PartiesService.listParties(Number(page), Number(limit), {
    search, status, partyType, partyTypes, sortBy, sortDir, canViewSensitive: canViewSensitive(req.user),
  });
  sendList(res, req, present(data, req), 'Parties retrieved successfully');
});

const getParty = asyncHandler(async (req, res) => {
  const data = await PartiesService.getParty(req.params.id);
  sendSuccess(res, present(data, req), 'Party retrieved successfully');
});

const createParty = asyncHandler(async (req, res) => {
  // The actor travels with the data: some fields need a grant beyond the route's.
  sendSuccess(res, present(await PartiesService.createParty(req.body, { actor: req.user }), req), 'Party created successfully', 201);
});

const updateParty = asyncHandler(async (req, res) => {
  sendSuccess(res, present(await PartiesService.updateParty(req.params.id, req.body, { actor: req.user }), req), 'Party updated successfully');
});

const deleteParty = asyncHandler(async (req, res) => {
  await PartiesService.deleteParty(req.params.id);
  sendSuccess(res, null, 'Party deleted successfully');
});

const upsertWageProfile = asyncHandler(async (req, res) => {
  const data = await PartiesService.upsertWageProfile(req.params.id, req.body, { actor: req.user });
  sendSuccess(res, maskRateFields(data, req), 'Wage profile saved successfully');
});

// --- FR-M04-2: addresses per party, each with a state code driving GST ---
const listAddresses = asyncHandler(async (req, res) => {
  sendSuccess(res, await PartyAddressService.listForParty(req.params.id), 'Addresses retrieved successfully');
});
const createAddress = asyncHandler(async (req, res) => {
  sendSuccess(res, await PartyAddressService.create(req.params.id, req.body), 'Address created successfully', 201);
});
const updateAddress = asyncHandler(async (req, res) => {
  // req.params.id is the party the address must belong to — see
  // PartyAddressService.get for why the pair is checked, not just the id.
  sendSuccess(res, await PartyAddressService.update(req.params.addressId, req.body, req.params.id), 'Address updated successfully');
});
const deleteAddress = asyncHandler(async (req, res) => {
  await PartyAddressService.remove(req.params.addressId, req.params.id);
  sendSuccess(res, null, 'Address deleted successfully');
});

module.exports = {
  listAddresses, createAddress, updateAddress, deleteAddress, listParties, getParty, createParty, updateParty, deleteParty, upsertWageProfile };
