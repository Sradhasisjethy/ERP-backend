const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories, assertCanUseFactory, assertCanSeeRecord } = require('../../core/salesScope');
const { CashRegisterService, DENOMINATIONS } = require('./cashRegister.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields } = require('../../utils/fieldMasking');


const maskDetail = (session, req) => ({
  ...maskRateFields(session, req),
  movements: maskRateFields(session.movements || [], req),
});

const list = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, status } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await CashRegisterService.list(Number(page), Number(limit), { status, baseWhere });
  sendList(res, req, maskRateFields(data, req), 'Cash register sessions retrieved');
});

/** The open session at a till, or null — what the counter screen asks on load. */
const current = asyncHandler(async (req, res) => {
  await assertCanUseFactory(req, req.query.factoryId);
  const session = await CashRegisterService.current(req.query.factoryId, req.query.accountId);
  sendSuccess(res, session ? maskDetail(session, req) : null, 'Current cash register session retrieved');
});

const get = asyncHandler(async (req, res) => {
  const session = await CashRegisterService.detail(req.params.id);
  await assertCanSeeRecord(req, session, 'Cash register session not found');
  sendSuccess(res, maskDetail(session, req), 'Cash register session retrieved');
});

const open = asyncHandler(async (req, res) => {
  await assertCanUseFactory(req, req.body.factoryId);
  sendSuccess(res, maskRateFields(await CashRegisterService.openSession(req.body), req), 'Till opened', 201);
});

const close = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await CashRegisterService.get(req.params.id), 'Cash register session not found');
  sendSuccess(res, maskRateFields(await CashRegisterService.closeSession(req.params.id, req.body), req), 'Till closed');
});

/** The note and coin values the count screen offers. */
const denominations = asyncHandler(async (req, res) => {
  sendSuccess(res, DENOMINATIONS, 'Denominations retrieved');
});

module.exports = { list, current, get, open, close, denominations };
