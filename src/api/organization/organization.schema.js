const { z } = require('zod');

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const CODE_REGEX = /^[A-Za-z0-9_-]{2,15}$/;

const organizationBody = z.object({
  name: z.string().trim().min(2, 'Organization Name must be at least 2 characters').max(100, 'Name cannot exceed 100 characters'),
  code: z.string().trim().toUpperCase().regex(CODE_REGEX, 'Code must be 2-15 alphanumeric characters (e.g. ACS)'),
  gstin: z.string().trim().toUpperCase().regex(GSTIN_REGEX, 'GSTIN must be 15 characters, e.g. 21ABCDE1234F1Z5'),
  description: z.string().optional(),
  settings: z.any().optional(),
});

// `validate()` with no explicit source validates { body, query, params } as one object,
// so the schema must mirror that shape — a bare (unwrapped) schema here would reject
// every request with "Required" since `name` etc. only exist under req.body.
const createOrganizationSchema = z.object({ body: organizationBody });
const updateOrganizationSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, 'Organization Name must be at least 2 characters').max(100, 'Name cannot exceed 100 characters').optional(),
    code: z.string().trim().toUpperCase().regex(CODE_REGEX, 'Code must be 2-15 alphanumeric characters (e.g. ACS)').optional(),
    gstin: z.string().trim().toUpperCase().regex(GSTIN_REGEX, 'GSTIN must be 15 characters, e.g. 21ABCDE1234F1Z5').optional(),
    description: z.string().optional(),
    settings: z.any().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  }),
});

const officeBody = z.object({
  organizationId: z.string().uuid('Organization is required'),
  name: z.string().trim().min(1, 'Office Name is required'),
  code: z.string().trim().min(1, 'Office Code is required'),
  address: z.string().trim().min(1, 'Address is required'),
  city: z.string().trim().min(1, 'City is required'),
  state: z.string().trim().min(1, 'State is required'),
  pincode: z.string().trim().min(1, 'Pincode is required'),
  country: z.string().trim().min(1, 'Country is required'),
  departmentIds: z.array(z.string().uuid()).optional(),
  geofenceRadius: z.coerce.number().int().optional(),
  latitude: z.coerce.number().optional(),
  longitude: z.coerce.number().optional(),
});

const createOfficeSchema = z.object({ body: officeBody });
const updateOfficeSchema = z.object({
  body: z.object({
    organizationId: z.string().uuid().optional(),
    name: z.string().trim().min(1, 'Office Name cannot be empty').optional(),
    code: z.string().trim().min(1, 'Office Code cannot be empty').optional(),
    address: z.string().trim().min(1, 'Address cannot be empty').optional(),
    city: z.string().trim().min(1, 'City cannot be empty').optional(),
    state: z.string().trim().min(1, 'State cannot be empty').optional(),
    pincode: z.string().trim().min(1, 'Pincode cannot be empty').optional(),
    country: z.string().trim().min(1, 'Country cannot be empty').optional(),
    departmentIds: z.array(z.string().uuid()).optional(),
    geofenceRadius: z.coerce.number().int().optional(),
    latitude: z.coerce.number().optional(),
    longitude: z.coerce.number().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  }),
});

const departmentBody = z.object({
  organizationId: z.string().uuid('Organization is required'),
  officeId: z.string().uuid().optional().nullable(),
  officeIds: z.array(z.string().uuid()).optional(),
  name: z.string().trim().min(1, 'Department Name is required'),
  code: z.string().trim().min(1, 'Department Code is required'),
  parentId: z.string().uuid().optional().nullable(),
  headId: z.string().uuid().optional().nullable(),
});

const createDepartmentSchema = z.object({ body: departmentBody });
const updateDepartmentSchema = z.object({
  body: z.object({
    organizationId: z.string().uuid().optional(),
    officeId: z.string().uuid().optional().nullable(),
    officeIds: z.array(z.string().uuid()).optional(),
    name: z.string().trim().min(1, 'Department Name cannot be empty').optional(),
    code: z.string().trim().min(1, 'Department Code cannot be empty').optional(),
    parentId: z.string().uuid().optional().nullable(),
    headId: z.string().uuid().optional().nullable(),
    status: z.enum(['active', 'inactive']).optional(),
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
  organizationId: z.string().uuid().optional(),
  officeId: z.string().uuid().optional(),
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
