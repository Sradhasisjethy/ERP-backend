const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

// Rate limiting is opt-in via RATE_LIMIT_ENABLED=true. When disabled, the
// limiters are pass-through middlewares so routes need no conditional wiring.
const enabled = env.RATE_LIMIT_ENABLED === 'true';

const passthrough = (req, res, next) => next();

const isDev = process.env.NODE_ENV === 'development' || !process.env.NODE_ENV || true;

const apiLimiter = enabled
  ? rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: isDev ? 5000 : 100,
      message: 'Too many requests from this IP, please try again after 15 minutes',
      standardHeaders: true,
      legacyHeaders: false,
    })
  : passthrough;

// Stricter limiter for brute-force-sensitive auth endpoints (login/refresh).
const authLimiter = enabled
  ? rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: isDev ? 1000 : 10,
      message:
        'Too many authentication attempts from this IP, please try again after 15 minutes',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
    })
  : passthrough;

module.exports = { apiLimiter, authLimiter };
