const { z } = require('zod');

const organizationBody = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  description: z.string().optional(),
  settings: z.any().optional(),
});

// `validate()` with no explicit source validates { body, query, params } as one object,
// so the schema must mirror that shape — a bare (unwrapped) schema here would reject
// every request with "Required" since `name` etc. only exist under req.body.
const createOrganizationSchema = z.object({ body: organizationBody });
const updateOrganizationSchema = z.object({
  body: organizationBody.partial().extend({
    status: z.enum(['active', 'inactive']).optional(),
  }),
});

const officeBody = z.object({
  organizationId: z.string().uuid(),
  name: z.string().min(1),
  code: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  geofenceRadius: z.coerce.number().int().optional(),
  latitude: z.coerce.number().optional(),
  longitude: z.coerce.number().optional(),
});

const createOfficeSchema = z.object({ body: officeBody });
const updateOfficeSchema = z.object({
  body: officeBody.partial().extend({
    status: z.enum(['active', 'inactive']).optional(),
  }),
});

const departmentBody = z.object({
  organizationId: z.string().uuid(),
  name: z.string().min(1),
  code: z.string().optional(),
  parentId: z.string().uuid().optional(),
  headId: z.string().uuid().optional(),
});

const createDepartmentSchema = z.object({ body: departmentBody });
const updateDepartmentSchema = z.object({
  body: departmentBody.partial().extend({
    status: z.enum(['active', 'inactive']).optional(),
  }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(20),
  search: z.string().optional(),
  status: z.enum(['active', 'inactive']).optional(),
  organizationId: z.string().uuid().optional(),
});

module.exports = {
  createOrganizationSchema,
  updateOrganizationSchema,
  createOfficeSchema,
  updateOfficeSchema,
  createDepartmentSchema,
  updateDepartmentSchema,
  listQuerySchema,
};
