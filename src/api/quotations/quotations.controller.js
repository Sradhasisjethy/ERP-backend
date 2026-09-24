const { asyncHandler } = require('../../core/asyncHandler');
const { scopeListToFactories, assertCanUseFactory, assertCanSeeRecord } = require('../../core/salesScope');
const { QuotationsService } = require('./quotations.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { maskRateFields, hasViewRates } = require('../../utils/fieldMasking');
const { hasPermission } = require('../../middlewares/authorize');

/**
 * Header totals and line amounts both carry money. This used to name both sets
 * by hand and mask them in two passes, because maskRateFields only reached the
 * top level; it now walks the whole payload, so one call covers both — and
 * covers any money field added later without this list having to be updated.
 */
const mask = (quotation, req) => maskRateFields(quotation, req);

const list = asyncHandler(async (req, res) => {
  const { page, limit, factoryId, status, customerPartyId, search } = req.query;
  const baseWhere = await scopeListToFactories(req, {}, factoryId);
  const data = await QuotationsService.list(Number(page), Number(limit), { status, customerPartyId, search, baseWhere });
  // maskRateFields understands a {rows, count} payload and walks each row's
  // lines, so the envelope and the rows no longer need masking separately.
  sendList(res, req, maskRateFields(data, req), 'Quotations retrieved successfully');
});

const get = asyncHandler(async (req, res) => {
  const quotation = await QuotationsService.getView(req.params.id);
  await assertCanSeeRecord(req, quotation, 'Quotation not found');
  sendSuccess(res, mask(quotation, req), 'Quotation retrieved successfully');
});

const create = asyncHandler(async (req, res) => {
  await assertCanUseFactory(req, req.body.factoryId);
  sendSuccess(res, mask(await QuotationsService.create(req.body), req), 'Quotation created successfully', 201);
});

const update = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await QuotationsService.getView(req.params.id), 'Quotation not found');
  sendSuccess(res, mask(await QuotationsService.update(req.params.id, req.body), req), 'Quotation updated successfully');
});

const setStatus = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await QuotationsService.getView(req.params.id), 'Quotation not found');
  const { status, reason } = req.body;
  sendSuccess(res, mask(await QuotationsService.setStatus(req.params.id, status, reason), req), `Quotation marked ${status.toLowerCase()}`);
});

const convert = asyncHandler(async (req, res) => {
  await assertCanSeeRecord(req, await QuotationsService.getView(req.params.id), 'Quotation not found');
  // The same two grants the sales-order screen applies, checked the same way.
  const allowCreditOverride = !!req.body.allowCreditOverride && hasPermission(req.user, 'SALES_CREDIT_OVERRIDE');
  const canOverrideMandatory = hasPermission(req.user, 'SALES_BUNDLE_OVERRIDE_MANDATORY');

  const { quotation, order, creditWarning, roundingDifferencePaise } = await QuotationsService.convert(req.params.id, {
    ...req.body, allowCreditOverride, canOverrideMandatory,
  });
  sendSuccess(
    res,
    {
      quotation: mask(quotation, req),
      order: maskRateFields(order.toJSON ? order.toJSON() : order, req),
      creditWarning,
      roundingDifferencePaise: hasViewRates(req) ? roundingDifferencePaise : null,
    },
    'Quotation converted to a sales order',
    201
  );
});

module.exports = { list, get, create, update, setStatus, convert };
