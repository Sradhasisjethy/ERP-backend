const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { UnauthorizedError } = require('../core/AppError');
const { EmployeeStatus } = require('../utils/constants');
const { sessionStateCache } = require('../core/sessionStateCache');

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

  // Several routers share the /api/v1 prefix and each runs this middleware, so
  // one request used to pass through it once per router it walked past —
  // measured at four identical user lookups, ~120 ms of every list request
  // against the remote database. The same token on the same request has
  // already been checked; checking it again cannot give a different answer.
  if (req.user && req.authenticatedToken === token) return next();

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
      // Held for a few seconds and dropped the instant this process changes
      // it — see core/sessionStateCache.js for why that is still immediate.
      let current = sessionStateCache.get(decoded.userId);
      if (!current) {
        const { User } = require('../api/users/user.model');
        const row = await User.unscoped().findByPk(decoded.userId, {
          attributes: ['id', 'permissionsVersion', 'status'],
        });
        current = row ? { permissionsVersion: row.permissionsVersion, status: row.status } : null;
        if (current) sessionStateCache.set(decoded.userId, current);
      }

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
  // Only a fully checked token is remembered — exempt paths skip the version
  // check, so they must not let a later router skip it too.
  if (!VERSION_EXEMPT.has(req.path)) req.authenticatedToken = token;
  next();
};

module.exports = { authenticate };
