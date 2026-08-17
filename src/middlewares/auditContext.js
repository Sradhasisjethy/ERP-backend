const { getTenantContext } = require('../core/tenantContext');

/**
 * Stashes the requesting user's id and IP address into the same CLS session that
 * tenantScope activates, so BaseAuditedModel hooks can attribute create/update
 * events (BR-30) without every service having to thread req through to the model
 * layer. Must run after tenantScope (which starts the session).
 */
const auditContext = (req, res, next) => {
  const session = getTenantContext();
  if (session && session.active) {
    session.set('userId', req.user && req.user.userId);
    session.set('ip', req.ip);
  }
  next();
};

module.exports = { auditContext };
