const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

// Rate limiting is opt-in via RATE_LIMIT_ENABLED=true. When disabled, the
// limiters are pass-through middlewares so routes need no conditional wiring.
const enabled = env.RATE_LIMIT_ENABLED === 'true';

const passthrough = (req, res, next) => next();

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
 * Exported so the limits can be asserted directly rather than inferred from
 * behaviour, which is what let the bug sit unnoticed.
 */
const resolveLimits = (nodeEnv) => {
  const relaxed = nodeEnv !== 'production';
  return { api: relaxed ? 5000 : 100, auth: relaxed ? 1000 : 10 };
};

const limits = resolveLimits(process.env.NODE_ENV);

const apiLimiter = enabled
  ? rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: limits.api,
      message: 'Too many requests from this IP, please try again after 15 minutes',
      standardHeaders: true,
      legacyHeaders: false,
    })
  : passthrough;

// Stricter limiter for brute-force-sensitive auth endpoints (login/refresh).
const authLimiter = enabled
  ? rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: limits.auth,
      message:
        'Too many authentication attempts from this IP, please try again after 15 minutes',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
    })
  : passthrough;

module.exports = { apiLimiter, authLimiter, resolveLimits };
