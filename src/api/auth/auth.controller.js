const { asyncHandler } = require('../../core/asyncHandler');
const { authService } = require('./auth.service');
const { sendSuccess } = require('../../utils/response');
const { env } = require('../../config/env');

const setCookies = (res, accessToken, refreshToken) => {
  const cookieOptions = {
    httpOnly: true,
    secure: env.NODE_ENV === 'production',
    sameSite: 'strict',
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
