const { ALL_PERMISSIONS, LEGACY_WRITE_ALIASES } = require('./permissionCatalog');

const SystemRoles = Object.freeze({
  PLATFORM_ADMIN: 'PLATFORM_ADMIN',
  TENANT_OWNER: 'TENANT_OWNER',
  ORG_ADMIN: 'ORG_ADMIN',
  HR_ADMIN: 'HR_ADMIN',
  MANAGER: 'MANAGER',
  EMPLOYEE: 'EMPLOYEE',
});

/**
 * Every grantable permission code, keyed by itself, generated from the catalog in
 * permissionCatalog.js so the two can never drift.
 *
 * Includes the deprecated `<RESOURCE>_WRITE` codes: no route guard uses them any
 * more, but roles stored before the split still hold them and `expandPermissions`
 * still honours them. Don't add new ones.
 */
const WebPermissions = Object.freeze(
  Object.fromEntries([...ALL_PERMISSIONS, ...Object.keys(LEGACY_WRITE_ALIASES)].map((code) => [code, code]))
);

const EmployeeType = Object.freeze({
  FULL_TIME: 'FULL_TIME',
  PART_TIME: 'PART_TIME',
  CONTRACT: 'CONTRACT',
  INTERN: 'INTERN',
});

const EmployeeStatus = Object.freeze({
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  ONBOARDING: 'ONBOARDING',
  TERMINATED: 'TERMINATED',
});

module.exports = { SystemRoles, WebPermissions, EmployeeType, EmployeeStatus };
