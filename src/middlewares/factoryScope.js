const { assertCanUseFactory } = require('../core/salesScope');

/**
 * Refuses any request that names a factory the caller has no access to.
 *
 * BR-29 location scoping was implemented per-controller during the sales,
 * purchasing, inventory and finance audits, which left the remaining modules —
 * expenses, production, returns, workforce, transfers, analytics and GST —
 * accepting `factoryId` as a plain filter. A user assigned to one plant could
 * read another plant's production, returns, wages and GST position simply by
 * naming its id.
 *
 * Mounted once per router, this closes every *explicit* cross-location request
 * — a read, a create, or a report for a forbidden factory — without each
 * controller having to remember. It deliberately does not try to filter list
 * results: a middleware cannot know a service's `where` clause, so lists are
 * scoped in the services themselves (see the `baseWhere` parameter each list
 * method takes).
 *
 * Must run after `authenticate` (it needs req.user) and is a no-op for the
 * bypass roles, which `core/factoryAccess.js` already handles.
 */
const enforceFactoryScope = async (req, res, next) => {
  try {
    const factoryId =
      (req.query && req.query.factoryId) ||
      (req.body && req.body.factoryId) ||
      (req.body && req.body.fromFactoryId);
    if (factoryId) await assertCanUseFactory(req, factoryId);

    // A transfer names two locations; the caller must be able to use both.
    if (req.body && req.body.toFactoryId) await assertCanUseFactory(req, req.body.toFactoryId);

    next();
  } catch (error) {
    next(error);
  }
};

module.exports = { enforceFactoryScope };
