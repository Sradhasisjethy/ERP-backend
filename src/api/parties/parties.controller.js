const { asyncHandler } = require('../../core/asyncHandler');
const { PartiesService } = require('./parties.service');
const { PartyAddressService } = require('./partyAddress.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

const listParties = asyncHandler(async (req, res) => {
  const { page, limit, search, status, partyType } = req.query;
  const data = await PartiesService.listParties(Number(page), Number(limit), { search, status, partyType });
  sendList(res, req, maskRateFields(data, req, ['creditLimitPaise']), 'Parties retrieved successfully');
});

const getParty = asyncHandler(async (req, res) => {
  const data = await PartiesService.getParty(req.params.id);
  sendSuccess(res, maskRateFields(data, req, ['creditLimitPaise']), 'Party retrieved successfully');
});

const createParty = asyncHandler(async (req, res) => {
  sendSuccess(res, await PartiesService.createParty(req.body), 'Party created successfully', 201);
});

const updateParty = asyncHandler(async (req, res) => {
  sendSuccess(res, await PartiesService.updateParty(req.params.id, req.body), 'Party updated successfully');
});

const deleteParty = asyncHandler(async (req, res) => {
  await PartiesService.deleteParty(req.params.id);
  sendSuccess(res, null, 'Party deleted successfully');
});

const upsertWageProfile = asyncHandler(async (req, res) => {
  const data = await PartiesService.upsertWageProfile(req.params.id, req.body);
  sendSuccess(res, maskRateFields(data, req, ['dailyWagePaise']), 'Wage profile saved successfully');
});

// --- FR-M04-2: addresses per party, each with a state code driving GST ---
const listAddresses = asyncHandler(async (req, res) => {
  sendSuccess(res, await PartyAddressService.listForParty(req.params.id), 'Addresses retrieved successfully');
});
const createAddress = asyncHandler(async (req, res) => {
  sendSuccess(res, await PartyAddressService.create(req.params.id, req.body), 'Address created successfully', 201);
});
const updateAddress = asyncHandler(async (req, res) => {
  sendSuccess(res, await PartyAddressService.update(req.params.addressId, req.body), 'Address updated successfully');
});
const deleteAddress = asyncHandler(async (req, res) => {
  await PartyAddressService.remove(req.params.addressId);
  sendSuccess(res, null, 'Address deleted successfully');
});

module.exports = {
  listAddresses, createAddress, updateAddress, deleteAddress, listParties, getParty, createParty, updateParty, deleteParty, upsertWageProfile };
