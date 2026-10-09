const { z } = require('zod');
const { EmployeeStatus, EmployeeType, SystemRoles } = require('../../utils/constants');
const { MAX_STRING, MAX_TEXT, MAX_SEARCH, nullableIsoDate, text, longText } = require('../../utils/zodFields');

/**
 * Only a path POST /users/avatar handed out. The field took any string, so a
 * profile picture could point at a tracking pixel on another host (fetched by
 * every colleague who opened the directory) or hold a multi-megabyte data: URL.
 * 255 matches the column the migration created. Whether the file is someone
 * else's is a database question, answered in user.service.js.
 */
const avatarPath = z
  .string()
  .max(255)
  .regex(/^\/uploads\/avatars\/avatar-[\w-]+\.(png|jpe?g|webp)$/,'Avatar must be an image uploaded through the avatar upload');

/**
 * Every string stops at the column it is stored in (employees.* are
 * VARCHAR(255) unless the model narrows them; address is TEXT). Joining and
 * resignation dates are business dates: the form sends YYYY-MM-DD from a date
 * input, and anything else used to reach Postgres to be guessed at.
 */
const profileFields = {
  phone: text().nullable().optional(),
  employeeCode: text().nullable().optional(),
  dateOfJoining: nullableIsoDate,
  resignationDate: nullableIsoDate,
  gender: text(50).nullable().optional(),
  assetName: text().nullable().optional(),
  assetCode: text(100).nullable().optional(),
  address: longText(MAX_TEXT).nullable().optional(),
  city: text().nullable().optional(),
  state: text().nullable().optional(),
  country: text().nullable().optional(),
  pincode: text(20).nullable().optional(),
  avatar: avatarPath.nullable().optional(),
};

const createUserSchema = z.object({
  body: z.object({
    email: z.string().email().max(MAX_STRING),
    password: z.string().min(8).max(MAX_STRING).optional(),
    firstName: text(),
    lastName: text(),
    sendInvite: z.boolean().optional(),
    organizationId: z.string().uuid().nullable().optional(),
    officeId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    employeeType: z.nativeEnum(EmployeeType).optional(),
    role: z.nativeEnum(SystemRoles).optional(),
    ...profileFields,
    roleId: z.string().uuid().nullable().optional(),
    status: z.nativeEnum(EmployeeStatus).optional(),
    managerId: z.string().uuid().nullable().optional(),
    hrId: z.string().uuid().nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
  }),
});

const updateUserSchema = z.object({
  body: z.object({
    email: z.string().email().max(MAX_STRING).optional(),
    firstName: text().optional(),
    lastName: text().optional(),
    organizationId: z.string().uuid().nullable().optional(),
    officeId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    employeeType: z.nativeEnum(EmployeeType).optional(),
    role: z.nativeEnum(SystemRoles).optional(),
    roleId: z.string().uuid().nullable().optional(),
    ...profileFields,
    status: z.nativeEnum(EmployeeStatus).optional(),
    managerId: z.string().uuid().nullable().optional(),
    hrId: z.string().uuid().nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
  }),
});

const listUsersQuerySchema = z.object({
  query: z.object({
    page: z.string().max(9).regex(/^\d+$/).transform(Number).default('1'),
    limit: z.string().max(9).regex(/^\d+$/).transform(Number).default('20'),
    search: z.string().max(MAX_SEARCH).optional(),
    status: z.nativeEnum(EmployeeStatus).optional(),
    employeeType: z.nativeEnum(EmployeeType).optional(),
    departmentId: z.string().uuid().optional(),
    organizationId: z.string().uuid().optional(),
  }),
});

/**
 * The verify toggle. The handler used to read `req.body.isVerified` unchecked,
 * so `{}` stored null and answered "Document unverified successfully", and a
 * string "false" was truthy enough to be reported as verified.
 */
const verifyDocumentSchema = z.object({
  body: z.object({ isVerified: z.boolean() }).strict(),
});

module.exports = { createUserSchema, updateUserSchema, listUsersQuerySchema, verifyDocumentSchema };
