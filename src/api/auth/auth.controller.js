const { asyncHandler } = require('../../core/asyncHandler');
const { authService } = require('./auth.service');
const { sendSuccess } = require('../../utils/response');
const { env } = require('../../config/env');
const { logger } = require('../../utils/logger');

/** Writes the BR-30 LOGIN audit row. Never fails the sign-in itself. */
const recordLogin = async (req, user) => {
  try {
    const { AuditLog } = require('../audit/auditLog.model');
    await AuditLog.create(
      {
        tenantId: user.tenantId,
        userId: user.id,
        ipAddress: req.ip || null,
        entityType: 'Session',
        entityId: user.id,
        action: 'LOGIN',
        beforeSnapshot: null,
        afterSnapshot: { email: user.email, role: user.role, userAgent: req.get('user-agent') || null },
      },
      { validate: false }
    );
  } catch (error) {
    logger.error({ message: 'Failed to record LOGIN audit row', error: error.message });
  }
};

const setCookies = (res, accessToken, refreshToken) => {
  const isProd = env.NODE_ENV === 'production';
  const cookieOptions = {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    path: '/',
  };

  if (accessToken) {
    res.cookie('accessToken', accessToken, {
      ...cookieOptions,
      maxAge: 15 * 60 * 1000, // 15 minutes
    });
  }

  if (refreshToken) {
    res.cookie('refreshToken', refreshToken, {
      ...cookieOptions,
      maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
    });
  }
};

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  const result = await authService.login(email, password);

  setCookies(res, result.accessToken, result.refreshToken);

  // BR-30 lists LOGIN among the actions that must be auditable, and it was the
  // one action with no trail at all: every other audit row is written by a
  // model hook, and signing in creates no record. Written here rather than in
  // the service because the IP lives on the request, and there is no CLS
  // session yet — login is the one path that runs before tenantScope.
  await recordLogin(req, result.user);

  sendSuccess(res, {
    user: result.user,
    accessToken: result.accessToken, // Optional, since it's in cookie, but standard practice to also return in body sometimes
  });
});

const refresh = asyncHandler(async (req, res) => {
  const refreshToken = req.cookies?.refreshToken;
  const result = await authService.refresh(refreshToken);

  setCookies(res, result.accessToken);

  sendSuccess(res, {
    accessToken: result.accessToken,
  });
});

const logout = asyncHandler(async (req, res) => {
  res.clearCookie('accessToken', { path: '/' });
  res.clearCookie('refreshToken', { path: '/' });
  sendSuccess(res, null, 'Logged out successfully');
});

const getMe = asyncHandler(async (req, res) => {
  const user = await authService.getMe(req.user.userId);
  sendSuccess(res, user);
});

const forgotPassword = asyncHandler(async (req, res) => {
  const { email } = req.body;
  const result = await authService.forgotPassword(email);
  sendSuccess(res, result, 'Password reset process initialized');
});

const resetPassword = asyncHandler(async (req, res) => {
  const { token, newPassword } = req.body;
  const result = await authService.resetPassword(token, newPassword);
  sendSuccess(res, result, 'Password reset successful');
});

module.exports = {
  login,
  refresh,
  logout,
  getMe,
  forgotPassword,
  resetPassword,
};
