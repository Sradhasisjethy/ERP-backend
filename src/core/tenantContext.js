const cls = require('cls-hooked');

const NAMESPACE_NAME = 'erp-tenant-namespace';

const getTenantContext = () => {
  return cls.getNamespace(NAMESPACE_NAME);
};

const getTenantId = () => {
  const session = getTenantContext();
  if (session && session.active) {
    return session.get('tenantId');
  }
  return undefined;
};

// Set by middlewares/auditContext.js, consumed by core/AuditedModel.js so audit
// rows can attribute who made a change and from where (BR-30) without every
// service having to pass req down to the model layer.
const getUserId = () => {
  const session = getTenantContext();
  if (session && session.active) {
    return session.get('userId');
  }
  return undefined;
};

const getIp = () => {
  const session = getTenantContext();
  if (session && session.active) {
    return session.get('ip');
  }
  return undefined;
};

module.exports = { NAMESPACE_NAME, getTenantContext, getTenantId, getUserId, getIp };
