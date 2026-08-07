const { z } = require('zod');

const createRoleSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  description: z.string().optional(),
  permissions: z.array(z.string()).default([]),
});

const updateRoleSchema = createRoleSchema.partial().extend({
  status: z.enum(['active', 'inactive']).optional(),
});

const assignMemberSchema = z.object({
  employeeId: z.string().uuid(),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

module.exports = { createRoleSchema, updateRoleSchema, assignMemberSchema, listQuerySchema };
