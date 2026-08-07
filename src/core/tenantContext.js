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

module.exports = { NAMESPACE_NAME, getTenantContext, getTenantId };
