const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { UnauthorizedError } = require('../core/AppError');
const { EmployeeStatus } = require('../utils/constants');

/**
 * Paths that only need a valid signature, because they exist to *fix* a stale
 * session. Refusing a token here because its permissions moved on would leave a
 * user unable to refresh out of the very state we are rejecting, and unable to
 * log out of it.
 */
const VERSION_EXEMPT = new Set(['/refresh', '/logout']);

const authenticate = async (req, res, next) => {
  const authHeader = req.headers.authorization;
  const bearerToken = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = req.cookies?.accessToken || bearerToken;

  if (!token) {
    return next(new UnauthorizedError('Access token is missing'));
  }

  let decoded;
  try {
    decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
  } catch (error) {
    return next(new UnauthorizedError('Invalid or expired token'));
  }

  /**
   * Signature alone is not enough.
   *
   * Permissions are resolved at login and baked into this token, and until now
   * that was the end of it — no lookup, no denylist. Removing a permission from
   * a role, taking someone out of a role, deactivating a role, demoting a
   * user's system role or disabling the account entirely all changed nothing
   * until the token expired, which is up to JWT_ACCESS_EXPIRATION (1 hour by
   * default) later. `revokeRefreshTokens` could not help: it only touches the
   * refresh table, so a live access token outlived every attempt to end the
   * session.
   *
   * One indexed read per request buys immediate, precise revocation. It is
   * scoped to two columns so the query stays small, and it doubles as the
   * account-status check — a user disabled mid-session is now out at once
   * rather than within the hour.
   */
  if (!VERSION_EXEMPT.has(req.path)) {
    // Express 4 does not catch a rejected promise from middleware, so the
    // database call is wrapped rather than left to surface as an unhandled
    // rejection and a hung request.
    try {
      const { User } = require('../api/users/user.model');
      const current = await User.unscoped().findByPk(decoded.userId, {
        attributes: ['id', 'permissionsVersion', 'status'],
      });

      if (!current) return next(new UnauthorizedError('Invalid or expired token'));

      if ([EmployeeStatus.INACTIVE, EmployeeStatus.TERMINATED].includes(current.status)) {
        return next(new UnauthorizedError('This account is no longer active'));
      }

      // A token minted before the last change to this user's access.
      // Deliberately the same shape of error as an expired token: the client
      // already knows how to refresh out of that, and refreshing re-resolves
      // permissions from the live rows.
      if ((decoded.permissionsVersion ?? 0) < current.permissionsVersion) {
        return next(new UnauthorizedError('Your access has changed — please sign in again'));
      }
    } catch (error) {
      return next(error);
    }
  }

  req.user = decoded;
  next();
};

module.exports = { authenticate };
