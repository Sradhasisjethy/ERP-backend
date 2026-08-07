const { Router } = require('express');
const { login, refresh, logout, getMe } = require('./auth.controller');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { validate } = require('../../middlewares/validate');
const { authLimiter } = require('../../middlewares/rateLimiter');
const { loginSchema, refreshSchema } = require('./auth.schema');

const router = Router();

router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/refresh', authLimiter, validate(refreshSchema), refresh);
router.post('/logout', logout);
router.get('/me', authenticate, tenantScope, getMe);

module.exports = { authRouter: router };
