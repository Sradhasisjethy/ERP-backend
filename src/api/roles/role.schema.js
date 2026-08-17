const { z } = require('zod');
const { isKnownPermission } = require('../../utils/permissionCatalog');

/**
 * Reject unknown codes outright rather than silently dropping them: a typo in a
 * permission name would otherwise save as a role that looks right in the UI and
 * grants nothing, which is the kind of bug nobody finds until an audit.
 */
const permissionCodes = z
  .array(z.string())
  .default([])
  .superRefine((codes, ctx) => {
    const unknown = [...new Set(codes.filter((code) => !isKnownPermission(code)))];
    if (unknown.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Unknown permission${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`,
      });
    }
  });

const roleBody = z.object({
  name: z.string().trim().min(1),
  code: z.string().trim().optional(),
  description: z.string().trim().optional(),
  permissions: permissionCodes,
});

// See organization.schema.js for why these are wrapped in `body:`.
const createRoleSchema = z.object({ body: roleBody });
const updateRoleSchema = z.object({
  body: roleBody.partial().extend({
    status: z.enum(['active', 'inactive']).optional(),
  }),
});

const assignMemberSchema = z.object({
  body: z.object({
    employeeId: z.string().uuid(),
  }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  search: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});

module.exports = { createRoleSchema, updateRoleSchema, assignMemberSchema, listQuerySchema };
