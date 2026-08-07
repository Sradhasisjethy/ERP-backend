const { ForbiddenError } = require('../core/AppError');
const { SystemRoles } = require('../utils/constants');

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

    // System roles bypass permission checks
    const bypassRoles = [SystemRoles.PLATFORM_ADMIN, SystemRoles.TENANT_OWNER];
    if (bypassRoles.includes(req.user.role)) {
      return next();
    }

    const permissions = req.user.permissions || [];
    const hasPermission = requiredPermissions.every((perm) => permissions.includes(perm));

    if (!hasPermission) {
      return next(new ForbiddenError('Insufficient permissions'));
    }

    next();
  };
};

module.exports = { authorize };
