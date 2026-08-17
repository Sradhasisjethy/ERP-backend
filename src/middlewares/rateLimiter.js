const rateLimit = require('express-rate-limit');
const { env } = require('../config/env');

// Rate limiting is opt-in via RATE_LIMIT_ENABLED=true. When disabled, the
// limiters are pass-through middlewares so routes need no conditional wiring.
const enabled = env.RATE_LIMIT_ENABLED === 'true';

const passthrough = (req, res, next) => next();

const apiLimiter = enabled
  ? rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 100, // limit each IP to 100 requests per windowMs
      message: 'Too many requests from this IP, please try again after 15 minutes',
      standardHeaders: true,
      legacyHeaders: false,
    })
  : passthrough;

// Stricter limiter for brute-force-sensitive auth endpoints (login/refresh).
const authLimiter = enabled
  ? rateLimit({
      windowMs: 15 * 60 * 1000, // 15 minutes
      max: 10, // limit each IP to 10 attempts per windowMs
      message:
        'Too many authentication attempts from this IP, please try again after 15 minutes',
      standardHeaders: true,
      legacyHeaders: false,
      skipSuccessfulRequests: true,
    })
  : passthrough;

module.exports = { apiLimiter, authLimiter };
