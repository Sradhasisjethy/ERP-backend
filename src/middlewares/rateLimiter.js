const rateLimit = require('express-rate-limit');
const jwt = require('jsonwebtoken');
const { env } = require('../config/env');

// RATE_LIMIT_ENABLED=true/false decides explicitly; left unset, limiting is on
// in production and off elsewhere. When disabled, the limiters are pass-through
// middlewares so routes need no conditional wiring.
const resolveEnabled = (flag, nodeEnv) => (flag === undefined ? nodeEnv === 'production' : flag === 'true');
const enabled = resolveEnabled(env.RATE_LIMIT_ENABLED, env.NODE_ENV);

const passthrough = (req, res, next) => next();

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

/**
 * Limits per environment.
 *
 * This used to be `const isDev = NODE_ENV === 'development' || !NODE_ENV || true`
 * — the trailing `|| true` made it unconditionally true, so a production
 * deployment with RATE_LIMIT_ENABLED=true still got the development ceilings:
 * 5000 API calls and 1000 login attempts per 15 minutes instead of 100 and 10.
 * Brute-force protection on /auth/login was effectively switched off in the
 * only environment where it matters.
 *
 * `api` is the anonymous (per-IP) ceiling and `apiUser` the per-signed-in-user
 * one. A tab polls the dashboard and notifications on its own (~25 requests per
 * window before anyone clicks anything), so 100 per IP throttled a few busy
 * users — or a whole office behind one NAT — into 429s. Signed-in traffic now
 * has a bucket per account; 100 stays for callers with no token, who only reach
 * the sign-in and reset pages.
 *
 * `forgotPassword` is per email per hour and the same everywhere: it protects a
 * stranger's mailbox, not server capacity.
 *
 * Exported so the limits can be asserted directly rather than inferred from
 * behaviour, which is what let the bug sit unnoticed.
 */
const resolveLimits = (nodeEnv) => {
  const relaxed = nodeEnv !== 'production';
  return {
    api: relaxed ? 5000 : 100,
    apiUser: relaxed ? 5000 : 1500,
    auth: relaxed ? 1000 : 10,
    forgotPassword: 3,
  };
};

const limits = resolveLimits(process.env.NODE_ENV);

// The API's own error envelope, so the client reads `message` the same way it
// does for every other failure. RateLimit-* headers still come from standardHeaders.
const jsonRefusal = (message) => (req, res, next, options) =>
  res.status(options.statusCode).json({ success: false, message });

// Platform probes must never be refused: a 429 on /health reads as a dead
// instance and gets it restarted under exactly the load that caused it.
const HEALTH_PATHS = new Set(['/health', '/health/live', '/health/ready']);
const isHealthCheck = (req) => HEALTH_PATHS.has(req.path.replace(/\/+$/, ''));

// cookie-parser is mounted after the API limiter, so read the raw header here.
const ACCESS_COOKIE = /(?:^|;\s*)accessToken=([^;]+)/;
const readAccessToken = (req) => {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) return header.slice(7);
  const match = ACCESS_COOKIE.exec(req.headers.cookie || '');
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
};

/**
 * Bucket key for the API limiter: the account when the request carries one of
 * our access tokens, the client IP otherwise.
 *
 * The signature is verified, never just decoded — an unverified userId is
 * caller-chosen text, and a fresh bucket per forged id is no limit at all. An
 * HS256 check costs microseconds and needs no database. Expiry is ignored on
 * purpose: a signature we issued still names a real account, and the requests
 * a tab makes between expiry and refresh belong to that user, not to everyone
 * else sharing the IP. Memoised on the request because `limit` asks again.
 */
const apiKey = (req) => {
  if (req.rateLimitKey) return req.rateLimitKey;
  let key = `ip:${req.ip}`;
  const token = readAccessToken(req);
  if (token) {
    try {
      const { userId } = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'], ignoreExpiration: true });
      if (userId) key = `user:${userId}`;
    } catch {
      // Forged, malformed or signed with another key: treated as anonymous.
    }
  }
  req.rateLimitKey = key;
  return key;
};

const buildApiLimiter = ({ enabled: on = enabled, nodeEnv = process.env.NODE_ENV } = {}) => {
  if (!on) return passthrough;
  const { api, apiUser } = resolveLimits(nodeEnv);
  return rateLimit({
    windowMs: WINDOW_MS,
    keyGenerator: apiKey,
    limit: (req) => (apiKey(req).startsWith('user:') ? apiUser : api),
    skip: isHealthCheck,
    handler: jsonRefusal('Too many requests, please try again after 15 minutes'),
    standardHeaders: true,
    legacyHeaders: false,
  });
};

const apiLimiter = buildApiLimiter();

// Stricter limiter for brute-force-sensitive auth endpoints (login/refresh).
const authLimiter = enabled
  ? rateLimit({
      windowMs: WINDOW_MS,
      max: limits.auth,
      handler: jsonRefusal('Too many authentication attempts from this IP, please try again after 15 minutes'),
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
    })
  : passthrough;

/**
 * Failed sign-ins per *account*, whatever address they come from.
 *
 * The limiter above buckets on IP, which stops one machine guessing but not a
 * botnet working through one account's password. This adds a ceiling per email.
 *
 * It is set at five times the per-IP limit on purpose. At the same ten as the
 * IP limiter, one attacker could lock any chosen user out indefinitely by
 * spending their own ten bad attempts on that email every fifteen minutes.
 * Now reaching the ceiling takes failures from at least five addresses, while
 * a distributed guess at one password still stops at fifty per window. A
 * successful sign-in does not count. Kept in process memory like the other
 * limiters — a second app instance needs a shared store for this to hold.
 */
const loginAccountLimiter = enabled
  ? rateLimit({
      windowMs: WINDOW_MS,
      max: limits.auth * 5,
      handler: jsonRefusal('Too many failed sign-in attempts for this account, please try again after 15 minutes'),
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
      keyGenerator: (req) => `login:${String(req.body?.email || '').trim().toLowerCase()}`,
    })
  : passthrough;

// The exact body POST /auth/forgot-password sends (controller message + the
// service's constant). auth.service.js does not export it, so it is copied;
// tests/rate-limit-abuse.test.js fails if the two drift apart, which would make
// a throttled reply distinguishable from a real one.
const FORGOT_PASSWORD_REPLY = {
  success: true,
  message: 'Password reset process initialized',
  data: { message: 'If an account exists with that email, a password reset link has been sent.' },
};

const forgotPasswordEmail = (req) =>
  typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';

/**
 * Reset emails per *recipient*. forgot-password always answers 200, so the
 * per-IP authLimiter (which skips successful requests) never counted it and
 * anyone could fill a stranger's inbox. Every request counts here, keyed on the
 * normalised address.
 *
 * Over the limit the reply is the normal one and the service is not called — a
 * 429 would tell the caller the address is being reset, which is what the
 * constant message exists to hide. RateLimit headers are off for the same
 * reason. A body with no email string is left for validation to refuse.
 */
const buildForgotPasswordLimiter = ({ enabled: on = enabled, nodeEnv = process.env.NODE_ENV } = {}) => {
  if (!on) return passthrough;
  return rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: resolveLimits(nodeEnv).forgotPassword,
    keyGenerator: (req) => `forgot:${forgotPasswordEmail(req)}`,
    skip: (req) => !forgotPasswordEmail(req),
    handler: (req, res) => res.status(200).json(FORGOT_PASSWORD_REPLY),
    standardHeaders: false,
    legacyHeaders: false,
  });
};

const forgotPasswordLimiter = buildForgotPasswordLimiter();

/**
 * File uploads per signed-in *user*. Every upload is a write to the server's
 * disk, and the API-wide limiter still allows a gigabyte of 10 MB documents.
 * Keyed on the user rather than the IP so one account cannot spread the writes
 * across addresses, and so an office behind one NAT is not throttled as one
 * person. Must run after authenticate.
 */
const uploadLimiter = enabled
  ? rateLimit({
      windowMs: WINDOW_MS,
      max: 30,
      handler: jsonRefusal('Too many uploads, please try again after 15 minutes'),
      standardHeaders: true,
      legacyHeaders: false,
      keyGenerator: (req) => `upload:${req.user?.userId}`,
    })
  : passthrough;

module.exports = {
  apiLimiter,
  authLimiter,
  loginAccountLimiter,
  forgotPasswordLimiter,
  uploadLimiter,
  buildApiLimiter,
  buildForgotPasswordLimiter,
  resolveLimits,
  resolveEnabled,
  FORGOT_PASSWORD_REPLY,
};
