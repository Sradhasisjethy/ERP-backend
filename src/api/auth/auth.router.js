const { Router } = require('express');
const { login, refresh, logout, logoutAll, changePassword, getMe, forgotPassword, resetPassword } = require('./auth.controller');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { validate } = require('../../middlewares/validate');
const { authLimiter, loginAccountLimiter, forgotPasswordLimiter } = require('../../middlewares/rateLimiter');
const { loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema, changePasswordSchema } = require('./auth.schema');

const router = Router();

router.post('/login', authLimiter, loginAccountLimiter, validate(loginSchema), login);
router.post('/refresh', authLimiter, validate(refreshSchema), refresh);
router.post('/logout', authLimiter, logout);
// authLimiter never counts this route (it always answers 200), so the
// per-recipient limiter is what stops anyone mailing a stranger without end.
router.post('/forgot-password', authLimiter, forgotPasswordLimiter, validate(forgotPasswordSchema), forgotPassword);
router.post('/reset-password', authLimiter, validate(resetPasswordSchema), resetPassword);
router.get('/me', authenticate, tenantScope, getMe);
// Signed-in session management: end every device, or change the password
// (which also ends every device). The limiter caps guessing the current password.
router.post('/logout-all', authenticate, tenantScope, logoutAll);
router.post('/change-password', authLimiter, authenticate, tenantScope, validate(changePasswordSchema), changePassword);

module.exports = { authRouter: router };
