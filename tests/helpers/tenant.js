const cls = require('cls-hooked');
const { NAMESPACE_NAME } = require('../../src/core/tenantContext');

/**
 * Opens a tenant CLS context around a call, the way the middleware chain does
 * for a real request.
 *
 * Services here read tenantId from CLS rather than taking it as a parameter, so
 * a test calling a service directly (bypassing HTTP) has to open that context
 * itself. Several test files already define this inline; this version takes the
 * tenant explicitly so one test can act as two different tenants — which is
 * what a cross-tenant isolation test needs.
 */
const runInTenantContext = (tenantId, fn, { userId } = {}) => {
  const session = cls.getNamespace(NAMESPACE_NAME) || cls.createNamespace(NAMESPACE_NAME);
  return session.runAndReturn(() => {
    session.set('tenantId', tenantId);
    if (userId) session.set('userId', userId);
    return fn();
  });
};

module.exports = { runInTenantContext };
