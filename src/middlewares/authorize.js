const { ForbiddenError } = require('../core/AppError');
const { SystemRoles } = require('../utils/constants');
const { holdsPermission } = require('../utils/permissionCatalog');

const BYPASS_ROLES = [SystemRoles.PLATFORM_ADMIN, SystemRoles.TENANT_OWNER];

/**
 * Same rule the `authorize` middleware enforces, exposed as a plain function
 * for controllers that need a permission check inline (e.g. deciding whether
 * to honour an optional override flag in the request body) rather than as a
 * route gate.
 */
const hasPermission = (user, permission) => {
  if (!user) return false;
  if (BYPASS_ROLES.includes(user.role)) return true;
  // `user.permissions` is already expanded (AuthService.getPermissionsForUser);
  // holdsPermission is what understands a role carrying the `*` wildcard.
  return holdsPermission(user.permissions || [], permission);
};

/**
 * RBAC authorization middleware.
 * Accepts one or more permission strings. The user must have ALL listed permissions.
 * System roles PLATFORM_ADMIN and TENANT_OWNER bypass all permission checks.
 */
const authorize = (...requiredPermissions) => {
  return (req, res, next) => {
    if (!req.user) {
      return next(new ForbiddenError('User not authenticated'));
    }

    if (!requiredPermissions.every((perm) => hasPermission(req.user, perm))) {
      return next(new ForbiddenError('Insufficient permissions'));
    }

    next();
  };
};

module.exports = { authorize, hasPermission };
