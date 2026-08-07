const { z } = require('zod');

const createOrganizationSchema = z.object({
  name: z.string().min(1),
  code: z.string().optional(),
  description: z.string().optional(),
  settings: z.any().optional(),
});

const updateOrganizationSchema = createOrganizationSchema.partial().extend({
  status: z.enum(['active', 'inactive']).optional(),
});

const createOfficeSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().min(1),
  code: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  geofenceRadius: z.number().int().optional(),
  latitude: z.number().optional(),
  longitude: z.number().optional(),
});

const updateOfficeSchema = createOfficeSchema.partial().extend({
  status: z.enum(['active', 'inactive']).optional(),
});

const createDepartmentSchema = z.object({
  organizationId: z.string().uuid(),
  name: z.string().min(1),
  code: z.string().optional(),
  parentId: z.string().uuid().optional(),
  headId: z.string().uuid().optional(),
});

const updateDepartmentSchema = createDepartmentSchema.partial().extend({
  status: z.enum(['active', 'inactive']).optional(),
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
