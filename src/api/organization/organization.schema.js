const { z } = require('zod');
const { MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_IDS } = require('../../utils/zodFields');

const GSTIN_REGEX = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const CODE_REGEX = /^[A-Za-z0-9_-]{2,15}$/;
// Indian statutory formats. Each is the format the issuing authority
// publishes, not a loose approximation — a wrong PAN on an invoice is a
// GST-filing defect, so the API refuses it at the door.
const PAN_REGEX = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const CIN_REGEX = /^[ULF][0-9]{5}[A-Z]{2}[0-9]{4}[A-Z]{3}[0-9]{6}$/;
const UDYAM_REGEX = /^UDYAM-[A-Z]{2}-[0-9]{2}-[0-9]{7}$/;
const PIN_REGEX = /^[1-9][0-9]{5}$/;
const STATE_CODE_REGEX = /^[0-9]{2}$/;
const IFSC_REGEX = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const BANK_ACCOUNT_REGEX = /^[0-9]{9,18}$/;
const PHONE_REGEX = /^(?:\+91[-\s]?)?[0-9]{10}$/;
const CURRENCY_REGEX = /^[A-Z]{3}$/;
// Same contract as user avatars: only a path this API issued through
// POST /organizations/logo is storable, never an arbitrary URL.
const LOGO_PATH_REGEX = /^\/uploads\/logos\/logo-[\w-]+\.(png|jpe?g|webp)$/;

// An optional field sent as '' (an emptied form input) means "not provided",
// not "validate the empty string against the format".
const optionalPattern = (regex, message) =>
  z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().toUpperCase().regex(regex, message).optional().nullable());

// The company profile fields shared by create and update. All optional at the
// API so existing orgs, imports and scripts keep working — the Add
// Organisation form is what enforces completeness; formats are enforced here.
const organizationProfileFields = {
  tradeName: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(2).max(150).optional().nullable()),
  pan: optionalPattern(PAN_REGEX, 'PAN must be 10 characters, e.g. ABCDE1234F'),
  cin: optionalPattern(CIN_REGEX, 'CIN must be 21 characters, e.g. U12345OD2020PTC123456'),
  udyam: optionalPattern(UDYAM_REGEX, 'Udyam number must look like UDYAM-OD-01-1234567'),
  addressLine1: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(3).max(MAX_STRING).optional().nullable()),
  addressLine2: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().max(MAX_STRING).optional().nullable()),
  city: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(2).max(MAX_STRING).optional().nullable()),
  state: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(2).max(MAX_STRING).optional().nullable()),
  stateCode: optionalPattern(STATE_CODE_REGEX, 'State code must be the two-digit GST code, e.g. 21'),
  pinCode: optionalPattern(PIN_REGEX, 'PIN code must be 6 digits and cannot start with 0'),
  email: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().toLowerCase().email('Enter a valid email address').max(MAX_STRING).optional().nullable()),
  phone: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().regex(PHONE_REGEX, 'Phone must be a 10-digit Indian number, with or without +91').optional().nullable()),
  baseCurrency: optionalPattern(CURRENCY_REGEX, 'Currency must be a 3-letter ISO code, e.g. INR'),
  fiscalYearStart: z.enum(['APRIL', 'JANUARY']).optional(),
  bankName: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(2).max(MAX_STRING).optional().nullable()),
  bankBranch: z.preprocess((v) => (v === '' ? undefined : v), z.string().trim().min(2).max(MAX_STRING).optional().nullable()),
  bankAccountNumber: optionalPattern(BANK_ACCOUNT_REGEX, 'Account number must be 9-18 digits'),
  bankIfsc: optionalPattern(IFSC_REGEX, 'IFSC must be 11 characters, e.g. SBIN0001234'),
  logo: z.preprocess((v) => (v === '' ? null : v), z.string().regex(LOGO_PATH_REGEX, 'Logo must be an image uploaded through the logo upload').optional().nullable()),
};

/**
 * The identifiers must agree with each other: a GSTIN embeds the state code
 * (chars 1-2) and the PAN (chars 3-12). A mismatch is always a data-entry
 * error, and catching it here is cheaper than a rejected GSTR filing.
 */
const statutoryConsistency = (data, ctx) => {
  const gstin = data.gstin;
  if (!gstin) return;
  if (data.stateCode && gstin.slice(0, 2) !== data.stateCode) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['stateCode'], message: `State code ${data.stateCode} does not match the GSTIN, which starts with ${gstin.slice(0, 2)}` });
  }
  if (data.pan && gstin.slice(2, 12) !== data.pan) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['pan'], message: `PAN ${data.pan} does not match the one embedded in the GSTIN (${gstin.slice(2, 12)})` });
  }
};

const organizationBody = z.object({
  name: z.string().trim().min(2, 'Organization Name must be at least 2 characters').max(100, 'Name cannot exceed 100 characters'),
  code: z.string().trim().toUpperCase().regex(CODE_REGEX, 'Code must be 2-15 alphanumeric characters (e.g. ACS)'),
  gstin: z.string().trim().toUpperCase().regex(GSTIN_REGEX, 'GSTIN must be 15 characters, e.g. 21ABCDE1234F1Z5'),
  description: z.string().max(MAX_TEXT).optional(),
  settings: z.any().optional(),
  ...organizationProfileFields,
}).superRefine(statutoryConsistency);

// `validate()` with no explicit source validates { body, query, params } as one object,
// so the schema must mirror that shape — a bare (unwrapped) schema here would reject
// every request with "Required" since `name` etc. only exist under req.body.
const createOrganizationSchema = z.object({ body: organizationBody });
const updateOrganizationSchema = z.object({
  body: z.object({
    name: z.string().trim().min(2, 'Organization Name must be at least 2 characters').max(100, 'Name cannot exceed 100 characters').optional(),
    code: z.string().trim().toUpperCase().regex(CODE_REGEX, 'Code must be 2-15 alphanumeric characters (e.g. ACS)').optional(),
    gstin: z.string().trim().toUpperCase().regex(GSTIN_REGEX, 'GSTIN must be 15 characters, e.g. 21ABCDE1234F1Z5').optional(),
    description: z.string().max(MAX_TEXT).optional(),
    settings: z.any().optional(),
    status: z.enum(['active', 'inactive']).optional(),
    ...organizationProfileFields,
    // Cross-field agreement against the STORED gstin (an update may send
    // stateCode or pan without resending the GSTIN) is enforced in the
    // service, which can see the row; here only same-request agreement.
  }).superRefine(statutoryConsistency),
});

const officeBody = z.object({
  organizationId: z.string().uuid('Organization is required'),
  name: z.string().trim().min(1, 'Office Name is required').max(MAX_STRING),
  code: z.string().trim().min(1, 'Office Code is required').max(MAX_STRING),
  address: z.string().trim().min(1, 'Address is required').max(MAX_TEXT),
  city: z.string().trim().min(1, 'City is required').max(MAX_STRING),
  state: z.string().trim().min(1, 'State is required').max(MAX_STRING),
  pincode: z.string().trim().min(1, 'Pincode is required').max(20),
  country: z.string().trim().min(1, 'Country is required').max(MAX_STRING),
  departmentIds: z.array(z.string().uuid()).max(MAX_IDS).optional(),
  geofenceRadius: z.coerce.number().int().finite().optional(),
  latitude: z.coerce.number().finite().optional(),
  longitude: z.coerce.number().finite().optional(),
});

const createOfficeSchema = z.object({ body: officeBody });
const updateOfficeSchema = z.object({
  body: z.object({
    organizationId: z.string().uuid().optional(),
    name: z.string().trim().min(1, 'Office Name cannot be empty').max(MAX_STRING).optional(),
    code: z.string().trim().min(1, 'Office Code cannot be empty').max(MAX_STRING).optional(),
    address: z.string().trim().min(1, 'Address cannot be empty').max(MAX_TEXT).optional(),
    city: z.string().trim().min(1, 'City cannot be empty').max(MAX_STRING).optional(),
    state: z.string().trim().min(1, 'State cannot be empty').max(MAX_STRING).optional(),
    pincode: z.string().trim().min(1, 'Pincode cannot be empty').max(20).optional(),
    country: z.string().trim().min(1, 'Country cannot be empty').max(MAX_STRING).optional(),
    departmentIds: z.array(z.string().uuid()).max(MAX_IDS).optional(),
    geofenceRadius: z.coerce.number().int().finite().optional(),
    latitude: z.coerce.number().finite().optional(),
    longitude: z.coerce.number().finite().optional(),
    status: z.enum(['active', 'inactive']).optional(),
  }),
});

const departmentBody = z.object({
  organizationId: z.string().uuid('Organization is required'),
  officeId: z.string().uuid().optional().nullable(),
  officeIds: z.array(z.string().uuid()).max(MAX_IDS).optional(),
  name: z.string().trim().min(1, 'Department Name is required').max(MAX_STRING),
  code: z.string().trim().min(1, 'Department Code is required').max(MAX_STRING),
  parentId: z.string().uuid().optional().nullable(),
  headId: z.string().uuid().optional().nullable(),
});

const createDepartmentSchema = z.object({ body: departmentBody });
const updateDepartmentSchema = z.object({
  body: z.object({
    organizationId: z.string().uuid().optional(),
    officeId: z.string().uuid().optional().nullable(),
    officeIds: z.array(z.string().uuid()).max(MAX_IDS).optional(),
    name: z.string().trim().min(1, 'Department Name cannot be empty').max(MAX_STRING).optional(),
    code: z.string().trim().min(1, 'Department Code cannot be empty').max(MAX_STRING).optional(),
    parentId: z.string().uuid().optional().nullable(),
    headId: z.string().uuid().optional().nullable(),
    status: z.enum(['active', 'inactive']).optional(),
  }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
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
