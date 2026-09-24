const { asyncHandler } = require('../../core/asyncHandler');
const { CrmService } = require('./crm.service');
const { SOURCES } = require('./crm.schema');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');

// What a lead might be worth is a money figure like any other (BR-27).

const list = asyncHandler(async (req, res) => {
  const { page, limit, status, openOnly, ownerId, source, search } = req.query;
  const data = await CrmService.list(Number(page), Number(limit), { status, openOnly: openOnly === 'true', ownerId, source, search });
  sendList(res, req, maskRateFields(data, req), 'Leads retrieved');
});

const get = asyncHandler(async (req, res) => {
  sendSuccess(res, maskRateFields(await CrmService.getView(req.params.id), req), 'Lead retrieved');
});

const create = asyncHandler(async (req, res) => {
  sendSuccess(res, maskRateFields(await CrmService.create(req.body), req), 'Lead created', 201);
});

const update = asyncHandler(async (req, res) => {
  sendSuccess(res, maskRateFields(await CrmService.update(req.params.id, req.body), req), 'Lead updated');
});

const setStatus = asyncHandler(async (req, res) => {
  const { status, reason } = req.body;
  sendSuccess(res, maskRateFields(await CrmService.setStatus(req.params.id, status, reason), req), `Lead marked ${status.toLowerCase()}`);
});

const convert = asyncHandler(async (req, res) => {
  const result = await CrmService.convert(req.params.id, req.body);
  sendSuccess(res, { ...result, lead: maskRateFields(result.lead, req) }, 'Lead converted to a customer', 201);
});

const addActivity = asyncHandler(async (req, res) => {
  sendSuccess(res, await CrmService.addActivity(req.params.id, req.body), 'Activity recorded', 201);
});

const completeActivity = asyncHandler(async (req, res) => {
  sendSuccess(res, await CrmService.completeActivity(req.params.id), 'Marked done');
});

const pendingTasks = asyncHandler(async (req, res) => {
  sendSuccess(res, await CrmService.pendingTasks(req.query), 'Pending follow-ups retrieved');
});

const pipeline = asyncHandler(async (req, res) => {
  sendSuccess(res, maskRateFields(await CrmService.pipeline(), req), 'Pipeline retrieved');
});

const sources = asyncHandler(async (req, res) => {
  sendSuccess(res, SOURCES, 'Lead sources retrieved');
});

module.exports = { list, get, create, update, setStatus, convert, addActivity, completeActivity, pendingTasks, pipeline, sources };
