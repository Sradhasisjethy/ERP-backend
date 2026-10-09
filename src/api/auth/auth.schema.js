const { z } = require('zod');
const { MAX_STRING } = require('../../utils/zodFields');

const loginSchema = z.object({
  body: z.object({
    email: z.string().email().max(MAX_STRING),
    password: z.string().min(1).max(MAX_STRING),
  }),
});

const refreshSchema = z.object({
  body: z
    .object({
      refreshToken: z.string().max(4096).optional(),
    })
    .optional(),
});

const forgotPasswordSchema = z.object({
  body: z.object({
    email: z.string().email('Please enter a valid email address').max(MAX_STRING),
  }),
});

const resetPasswordSchema = z.object({
  body: z.object({
    token: z.string().min(1, 'Token is required').max(512),
    newPassword: z.string().min(8, 'Password must be at least 8 characters long').max(MAX_STRING),
  }),
});

const changePasswordSchema = z.object({
  body: z.object({
    currentPassword: z.string().min(1, 'Current password is required').max(MAX_STRING),
    newPassword: z.string().min(8, 'Password must be at least 8 characters long').max(MAX_STRING),
  }),
});

module.exports = { loginSchema, refreshSchema, forgotPasswordSchema, resetPasswordSchema, changePasswordSchema };
