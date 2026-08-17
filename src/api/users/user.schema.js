const { z } = require('zod');
const { EmployeeStatus, EmployeeType, SystemRoles } = require('../../utils/constants');

const createUserSchema = z.object({
  body: z.object({
    email: z.string().email(),
    password: z.string().min(8).optional(),
    firstName: z.string(),
    lastName: z.string(),
    sendInvite: z.boolean().optional(),
    organizationId: z.string().uuid().optional(),
    officeId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    employeeType: z.nativeEnum(EmployeeType).optional(),
    role: z.nativeEnum(SystemRoles).optional(),
    phone: z.string().optional(),
    employeeCode: z.string().optional(),
    dateOfJoining: z.string().optional(),
  }),
});

const updateUserSchema = z.object({
  body: z.object({
    email: z.string().email().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    organizationId: z.string().uuid().optional(),
    officeId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    employeeType: z.nativeEnum(EmployeeType).optional(),
    role: z.nativeEnum(SystemRoles).optional(),
    phone: z.string().optional(),
    employeeCode: z.string().optional(),
    dateOfJoining: z.string().optional(),
    status: z.nativeEnum(EmployeeStatus).optional(),
    managerId: z.string().uuid().optional(),
    hrId: z.string().uuid().optional(),
    parentId: z.string().uuid().optional(),
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
