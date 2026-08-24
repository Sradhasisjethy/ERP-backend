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

/** Throws ForbiddenError unless the caller may act on `factoryId`. */
const assertCanUseFactory = async (req, factoryId) => {
  assertFactoryAccess(await getAllowedFactoryIds(req), factoryId);
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

module.exports = { scopeListToFactories, assertCanUseFactory, assertCanSeeRecord };
