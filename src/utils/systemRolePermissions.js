const { SystemRoles, WebPermissions } = require('./constants');
const { ALL_PERMISSIONS } = require('./permissionCatalog');

/**
 * What the `users.role` column confers on its own, before any AdGroup is
 * consulted.
 *
 * This lived inline in AuthService.getPermissionsForUser, which was fine while
 * login was the only caller. It is extracted because assigning the column is
 * itself a grant: whoever edits a user's role hands out everything listed here,
 * so the user-administration guard has to be able to ask what a given role is
 * worth. Two copies of this mapping would be two things to keep in step, and
 * the one that drifted would be the one deciding whether an escalation is
 * allowed.
 *
 * EMPLOYEE deliberately returns nothing — see the long note at the call site in
 * auth.service.js for why that stopped being a blanket read grant.
 */

/** Every `<RESOURCE>_READ` in the catalog, derived so it cannot fall behind. */
const ALL_READS = ALL_PERMISSIONS.filter((code) => code.endsWith('_READ'));

/**
 * Grants that are never part of administering an organisation, and which
 * ORG_ADMIN silently held because its branch returned the entire catalog.
 *
 * Each is a deliberate, separately-granted act somewhere else in the system:
 * running the one-time opening-balance import, signing off a variance or an
 * indent, overriding a curing period or FIFO, or pushing an order past a
 * customer's credit limit. Holding them by virtue of a job title is exactly
 * what the named-grant design exists to avoid.
 */
const NEVER_BY_JOB_TITLE = new Set([
  WebPermissions.MIGRATION_RUN,
  WebPermissions.PURCHASE_APPROVE,
  WebPermissions.LEAVE_APPROVE,
  WebPermissions.PRODUCTION_APPROVE_VARIANCE,
  WebPermissions.OVERRIDE_CURING,
  WebPermissions.OVERRIDE_LOT_SELECTION,
  WebPermissions.SALES_CREDIT_OVERRIDE,
  WebPermissions.SALES_BUNDLE_OVERRIDE_MANDATORY,
]);

/**
 * ORG_ADMIN: administers the organisation, and can see the business.
 *
 * It used to return `Object.values(WebPermissions)` — literally every code,
 * including MIGRATION_RUN and every override and approval grant. That made it a
 * superuser under a name that does not read like one, and because the grant
 * came from a hardcoded branch rather than a role row, it was invisible in
 * Administration > Roles and no administrator could take any of it away. It is
 * also *not* in the `authorize.js` bypass list, so nothing about it looked
 * privileged from the outside.
 *
 * Now enumerated: full control of the administration surface (users, roles, org
 * structure, locations, settings), read access across every module so the role
 * can still oversee operations, the audit log, and rate visibility. What it no
 * longer gets by default is transactional write and the named grants above — a
 * tenant that wants those for a particular person grants them through a role,
 * where they are visible and revocable.
 *
 * This is a reduction in what an existing ORG_ADMIN can do. That is the
 * intended direction for a privilege that nobody could see, but it is a
 * behaviour change: a deployment relying on ORG_ADMIN as a second superuser
 * should give those users a role carrying `*` instead.
 */
const ORG_ADMIN_PERMISSIONS = [
  ...new Set([
    // The administration surface, in full.
    WebPermissions.EMPLOYEE_READ, WebPermissions.EMPLOYEE_CREATE,
    WebPermissions.EMPLOYEE_MODIFY, WebPermissions.EMPLOYEE_DELETE,
    WebPermissions.ROLE_READ, WebPermissions.ROLE_CREATE,
    WebPermissions.ROLE_MODIFY, WebPermissions.ROLE_DELETE,
    WebPermissions.ORG_READ, WebPermissions.ORG_CREATE,
    WebPermissions.ORG_MODIFY, WebPermissions.ORG_DELETE,
    WebPermissions.FACTORY_READ, WebPermissions.FACTORY_CREATE,
    WebPermissions.FACTORY_MODIFY, WebPermissions.FACTORY_DELETE,
    WebPermissions.SETTINGS_READ, WebPermissions.SETTINGS_CREATE,
    WebPermissions.SETTINGS_MODIFY, WebPermissions.SETTINGS_DELETE,
    // Oversight: see everything, change nothing transactional by default.
    ...ALL_READS,
    WebPermissions.VIEW_RATES,
  ]),
].filter((code) => code && !NEVER_BY_JOB_TITLE.has(code));

const permissionsForSystemRole = (role) => {
  // The two roles authorize.js lets past every check anyway. Listing the whole
  // catalog for them is redundant but harmless, and keeps `grantableFor` honest.
  if ([SystemRoles.PLATFORM_ADMIN, SystemRoles.TENANT_OWNER].includes(role)) {
    return Object.values(WebPermissions);
  }

  if (role === SystemRoles.ORG_ADMIN) {
    return ORG_ADMIN_PERMISSIONS;
  }

  if (role === SystemRoles.HR_ADMIN) {
    return [
      WebPermissions.EMPLOYEE_READ,
      WebPermissions.EMPLOYEE_WRITE,
      WebPermissions.ORG_READ,
      WebPermissions.ROLE_READ,
    ];
  }

  if (role === SystemRoles.MANAGER) {
    return [
      WebPermissions.EMPLOYEE_READ,
      WebPermissions.ORG_READ,
      WebPermissions.PARTY_READ,
      WebPermissions.PRODUCT_READ,
      WebPermissions.INVENTORY_READ,
      WebPermissions.SALES_READ,
      WebPermissions.PURCHASE_READ,
      WebPermissions.PRODUCTION_READ,
      WebPermissions.QUALITY_READ,
      WebPermissions.TRANSFER_READ,
      WebPermissions.DISPATCH_READ,
      WebPermissions.INVOICE_READ,
    ];
  }

  return [];
};

module.exports = { permissionsForSystemRole, ORG_ADMIN_PERMISSIONS };
