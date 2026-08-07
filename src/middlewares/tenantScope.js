const { getTenantContext } = require('../core/tenantContext');
const { UnauthorizedError } = require('../core/AppError');

/**
 * Middleware that injects tenant context from the authenticated user's JWT
 * into the CLS namespace so that BaseScopedModel hooks can auto-filter queries.
 */
const tenantScope = (req, res, next) => {
  if (!req.user || !req.user.tenantId) {
    return next(new UnauthorizedError('Tenant context missing from token'));
  }

  const session = getTenantContext();
  if (!session) {
    return next(new UnauthorizedError('Tenant namespace not initialized'));
  }

  session.run(() => {
    session.set('tenantId', req.user.tenantId);
    next();
  });
};

module.exports = { tenantScope };
