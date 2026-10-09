const { Op } = require('sequelize');
const { getAllowedFactoryIds, applyFactoryFilter, assertFactoryAccess } = require('./factoryAccess');
const { NotFoundError } = require('./AppError');

/**
 * BR-29 location scoping for the transactional modules.
 *
 * `core/factoryAccess.js` has always held the logic, but before this only the
 * dashboard and the reports runner called it. Every transactional endpoint —
 * sales orders, delivery challans, sales invoices, receipts, payments —
 * accepted `factoryId` purely as an optional *filter* and applied no
 * restriction when it was omitted. A user assigned only to Plant B could list
 * and open every Plant A order, challan and invoice, and could raise documents
 * *against* Plant A, simply by naming its id.
 *
 * These helpers make the check one line at each call site so it is hard to
 * leave out, and so "which factories may this user see" keeps living in one
 * place.
 */

/** Adds the caller's factory restriction to a `where`, honouring ?factoryId=. */
const scopeListToFactories = async (req, where = {}, requestedFactoryId) => {
  const allowed = await getAllowedFactoryIds(req);
  return applyFactoryFilter(where, allowed, requestedFactoryId);
};

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Throws ForbiddenError unless the caller may act on `factoryId`, and
 * NotFoundError unless that factory exists in the caller's tenant.
 *
 * The existence check is for every caller, but it is the bypass roles it
 * matters for: their allowed list is `null`, so before this a tenant owner (or
 * a platform admin acting in one tenant) could name *another* tenant's factory
 * id and have it accepted — the document then carried a foreign plant. 404
 * rather than 403 for the reason assertCanSeeRecord gives.
 *
 * An absent id keeps its old meaning (a bypass caller passes, anyone else is
 * refused): whether the field is required is the validator's call, not this.
 */
const assertCanUseFactory = async (req, factoryId) => {
  assertFactoryAccess(await getAllowedFactoryIds(req), factoryId);
  if (!factoryId) return;

  // A malformed id cannot exist, and Postgres would 500 on the cast.
  if (!UUID_RE.test(String(factoryId))) throw new NotFoundError('Factory not found');
  const { Factory } = require('../api/factory/factory.model');
  const factory = await Factory.findOne({
    // The model hook adds the CLS tenant as well; naming it here keeps the
    // check honest on a path that runs without tenantScope.
    where: { id: factoryId, ...(req.user.tenantId ? { tenantId: req.user.tenantId } : {}) },
    attributes: ['id'],
  });
  if (!factory) throw new NotFoundError('Factory not found');
};

/**
 * Guards a single fetched record.
 *
 * Deliberately 404, not 403: a user who may not see Plant A should not be able
 * to confirm that a given order id exists there. The distinction leaks
 * document volumes and numbering across locations otherwise.
 */
const assertCanSeeRecord = async (req, record, notFoundMessage) => {
  const allowed = await getAllowedFactoryIds(req);
  if (allowed === null) return record;
  if (!record || !allowed.includes(record.factoryId)) throw new NotFoundError(notFoundMessage);
  return record;
};

/**
 * The same rule for a document that names *two* locations — a stock transfer
 * has `fromFactoryId` and `toFactoryId` and no plain `factoryId`, so
 * applyFactoryFilter has nothing to match on and `scopeListToFactories` was
 * silently a no-op for it. (The transfer service already accepted a `baseWhere`
 * for exactly this; the controller never passed one.)
 *
 * A transfer is visible when *either* end is a location the caller can see:
 * both the despatching and the receiving plant have a legitimate interest in
 * it, and a transfer only one of them could see would be invisible to the
 * other.
 */
const scopeListToEitherFactory = async (req, where = {}) => {
  const allowed = await getAllowedFactoryIds(req);
  if (allowed === null) return where;

  const ids = allowed.length ? allowed : ['00000000-0000-0000-0000-000000000000'];
  return {
    ...where,
    [Op.and]: [
      ...(where[Op.and] || []),
      { [Op.or]: [{ fromFactoryId: { [Op.in]: ids } }, { toFactoryId: { [Op.in]: ids } }] },
    ],
  };
};

/** Guards one two-location record. 404 for the reason assertCanSeeRecord is. */
const assertCanSeeTransfer = async (req, record, notFoundMessage) => {
  const allowed = await getAllowedFactoryIds(req);
  if (allowed === null) return record;
  const visible =
    record && (allowed.includes(record.fromFactoryId) || allowed.includes(record.toFactoryId));
  if (!visible) throw new NotFoundError(notFoundMessage);
  return record;
};

module.exports = {
  scopeListToFactories,
  assertCanUseFactory,
  assertCanSeeRecord,
  scopeListToEitherFactory,
  assertCanSeeTransfer,
};
