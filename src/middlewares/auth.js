const jwt = require('jsonwebtoken');
const { env } = require('../config/env');
const { UnauthorizedError } = require('../core/AppError');
const { EmployeeStatus } = require('../utils/constants');
const { sessionStateCache } = require('../core/sessionStateCache');

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
  // There used to be a path-based exemption here for '/refresh' and '/logout'.
  // Those routes never run this middleware, and `req.path` is relative to
  // whichever router is matching, so the exemption applied to any '/refresh' or
  // '/logout' in *every* router — `GET /api/v1/users/refresh` skipped the status
  // and version check. Every authenticated request is now checked.
  //
  // Express 4 does not catch a rejected promise from middleware, so the
  // database call is wrapped rather than left to surface as an unhandled
  // rejection and a hung request.
  try {
    // Held for a few seconds and dropped the instant this process changes
    // it — see core/sessionStateCache.js for why that is still immediate.
    let current = sessionStateCache.get(decoded.userId);
    if (!current) {
      const { User } = require('../api/users/user.model');
      const { Tenant } = require('../api/organization/tenant.model');
      const row = await User.unscoped().findByPk(decoded.userId, {
        attributes: ['id', 'permissionsVersion', 'status', 'tenantId'],
      });
      // A suspended company's users are out mid-session, not just at the next
      // login. Cached with the rest, so it costs a read per cache miss only.
      const tenant = row ? await Tenant.findByPk(row.tenantId, { attributes: ['id', 'status'] }) : null;
      current = row
        ? {
            permissionsVersion: row.permissionsVersion,
            status: row.status,
            tenantBlocked: !tenant || ['inactive', 'suspended'].includes(tenant.status),
          }
        : null;
      if (current) sessionStateCache.set(decoded.userId, current);
    }

    if (!current) return next(new UnauthorizedError('Invalid or expired token'));

    if (current.tenantBlocked) {
      return next(new UnauthorizedError('This account is no longer active'));
    }

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

  req.user = decoded;
  req.authenticatedToken = token;
  next();
};

module.exports = { authenticate };
