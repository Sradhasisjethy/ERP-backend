const { z } = require('zod');
const { EmployeeStatus, EmployeeType, SystemRoles } = require('../../utils/constants');

const createUserSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(8).optional(),
    firstName: z.string(),
    lastName: z.string(),
    sendInvite: z.boolean().optional(),
    organizationId: z.string().uuid().nullable().optional(),
    officeId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    employeeType: z.nativeEnum(EmployeeType).optional(),
    role: z.nativeEnum(SystemRoles).optional(),
    phone: z.string().nullable().optional(),
    employeeCode: z.string().nullable().optional(),
    dateOfJoining: z.string().nullable().optional(),
    resignationDate: z.string().nullable().optional(),
    gender: z.string().nullable().optional(),
    assetName: z.string().nullable().optional(),
    assetCode: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    pincode: z.string().nullable().optional(),
    avatar: z.string().nullable().optional(),
    roleId: z.string().uuid().nullable().optional(),
  }),
});

const updateUserSchema = z.object({
  body: z.object({
    email: z.string().email().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    organizationId: z.string().uuid().nullable().optional(),
    officeId: z.string().uuid().nullable().optional(),
    departmentId: z.string().uuid().nullable().optional(),
    employeeType: z.nativeEnum(EmployeeType).optional(),
    role: z.nativeEnum(SystemRoles).optional(),
    roleId: z.string().uuid().nullable().optional(),
    phone: z.string().nullable().optional(),
    employeeCode: z.string().nullable().optional(),
    dateOfJoining: z.string().nullable().optional(),
    resignationDate: z.string().nullable().optional(),
    gender: z.string().nullable().optional(),
    assetName: z.string().nullable().optional(),
    assetCode: z.string().nullable().optional(),
    address: z.string().nullable().optional(),
    city: z.string().nullable().optional(),
    state: z.string().nullable().optional(),
    country: z.string().nullable().optional(),
    pincode: z.string().nullable().optional(),
    avatar: z.string().nullable().optional(),
    status: z.nativeEnum(EmployeeStatus).optional(),
    managerId: z.string().uuid().nullable().optional(),
    hrId: z.string().uuid().nullable().optional(),
    parentId: z.string().uuid().nullable().optional(),
  }),
});

const listUsersQuerySchema = z.object({
  query: z.object({
    page: z.string().regex(/^\d+$/).transform(Number).default('1'),
    limit: z.string().regex(/^\d+$/).transform(Number).default('20'),
    search: z.string().optional(),
    status: z.nativeEnum(EmployeeStatus).optional(),
    employeeType: z.nativeEnum(EmployeeType).optional(),
    departmentId: z.string().uuid().optional(),
    organizationId: z.string().uuid().optional(),
  }),
});

module.exports = { createUserSchema, updateUserSchema, listUsersQuerySchema };
