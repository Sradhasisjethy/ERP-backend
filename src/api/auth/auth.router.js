const { Router } = require('express');
const { login, refresh, logout, getMe, forgotPassword, resetPassword } = require('./auth.controller');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { validate } = require('../../middlewares/validate');
const { authLimiter } = require('../../middlewares/rateLimiter');
const { loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema } = require('./auth.schema');

const router = Router();

router.post('/login', authLimiter, validate(loginSchema), login);
router.post('/refresh', authLimiter, validate(refreshSchema), refresh);
router.post('/logout', logout);
router.post('/forgot-password', authLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), resetPassword);
router.get('/me', authenticate, tenantScope, getMe);

module.exports = { authRouter: router };
