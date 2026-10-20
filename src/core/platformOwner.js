const { getTenantContext } = require('./tenantContext');
const { ForbiddenError } = require('./AppError');

/**
 * The application owner: the business that runs this ERP for the
 * organisations using it, as distinct from any organisation's administrator.
 *
 * Named by email in PLATFORM_OWNER_EMAILS on the server, never by a role.
 * Every role here lives inside an organisation, and PLATFORM_ADMIN and
 * TENANT_OWNER are held by customers' own administrators (and by test
 * organisations), so a role cannot say "this is the platform's owner".
 * Nothing in the app can grant this; it changes only with the deployment.
 *
 * Read from process.env at call time rather than captured at load, so a
 * change of owner takes effect on restart without code reading a stale copy.
 */
const ownerEmails = () =>
  String(process.env.PLATFORM_OWNER_EMAILS || '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

const isPlatformOwnerEmail = (email) => Boolean(email) && ownerEmails().includes(String(email).trim().toLowerCase());

/**
 * Route guard. Runs after `authenticate`; looks the account up because the
 * access token carries no email. Deliberately not a permission: authorize()
 * lets PLATFORM_ADMIN and TENANT_OWNER through everything, which is exactly
 * who must not get in here.
 */
const requirePlatformOwner = async (req, res, next) => {
  try {
    const { User } = require('../api/users/user.model');
    const user = req.user && (await User.findByPk(req.user.userId, { attributes: ['id', 'email', 'status'] }));
    if (!user || !isPlatformOwnerEmail(user.email)) return next(new ForbiddenError('Only the application owner can use the privacy desk'));
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * A CLS session with who and from where, but no tenant: the owner's desk reads
 * across every organisation (the scoped models filter only when a tenantId is
 * set). Writes about one organisation's records go through `asTenant`.
 */
const platformContext = (req, res, next) => {
  const session = getTenantContext();
  session.run(() => {
    // Explicitly none. A new session inherits whatever context is active, and
    // cls-hooked can leave a previous request's tenant there; inheriting it
    // would quietly narrow the desk to one organisation, or file a public
    // request under one.
    session.set('tenantId', null);
    session.set('userId', req.user && req.user.userId);
    session.set('ip', req.ip);
    next();
  });
};

/** Runs `fn` as the given organisation, keeping the caller's user and IP for the audit trail. */
const asTenant = (tenantId, fn) => {
  const session = getTenantContext();
  return session.runAndReturn(() => {
    session.set('tenantId', tenantId);
    return fn();
  });
};

module.exports = { isPlatformOwnerEmail, requirePlatformOwner, platformContext, asTenant, ownerEmails };
