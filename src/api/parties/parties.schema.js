const { z } = require('zod');

/**
 * 15 characters: 2-digit state code, the 10-character PAN of the holder, a
 * 1-digit entity number, the literal 'Z', and a checksum character. Validated
 * because the GSTIN is what GSTR-1/3B are filed against and what the
 * place-of-supply state code is read from — a malformed one is not caught
 * until the return is rejected, long after the invoice went out.
 */
const GSTIN_PATTERN = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$/;
const gstin = z
  .string()
  .trim()
  .toUpperCase()
  .regex(GSTIN_PATTERN, 'GSTIN must be 15 characters, e.g. 21ABCDE1234F1Z5');

const partyBody = z.object({
  partyType: z.enum(['CUSTOMER', 'VENDOR', 'CONTRACTOR', 'LABOUR', 'SALES_REF']),
  name: z.string().min(1),
  code: z.string().optional(),
  gstin: gstin.optional(),
  phone: z.string().trim().min(6).max(20).optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  gstType: z.string().nullable().optional(),
  legalName: z.string().nullable().optional(),
  creditLimitPaise: z.coerce.number().int().min(0).optional(),
  creditAgeingDays: z.coerce.number().int().min(0).optional(),
  creditAction: z.enum(['NONE', 'WARN', 'BLOCK']).optional(),
  openingBalance: z.coerce.number().optional(),
  asOfDate: z.string().nullable().optional(),
  paymentTerms: z.string().nullable().optional(),
  pincode: z.string().nullable().optional(),
  billingAddress: z.string().nullable().optional(),
  creditPeriodDays: z.coerce.number().int().min(0).optional(),
  noOfCredits: z.coerce.number().int().min(0).optional(),
  relationshipSince: z.string().nullable().optional(),
  distanceKm: z.coerce.number().optional(),
  transportation: z.string().nullable().optional(),
  balanceType: z.string().nullable().optional(),
  pan: z.string().nullable().optional(),
  msmeCategory: z.string().nullable().optional(),
  udyamNumber: z.string().nullable().optional(),
  tdsApplicable: z.coerce.boolean().optional(),
  tdsSection: z.string().nullable().optional(),
  bankAccountNumber: z.string().nullable().optional(),
  bankIfsc: z.string().nullable().optional(),
  bankName: z.string().nullable().optional(),
  bankBranch: z.string().nullable().optional(),
  beneficiaryName: z.string().nullable().optional(),
  pfCode: z.string().nullable().optional(),
  esicNumber: z.string().nullable().optional(),
  laborLicenseNumber: z.string().nullable().optional(),
  workCategory: z.string().nullable().optional(),
  retentionPercent: z.coerce.number().min(0).max(100).optional(),
  entityType: z.string().nullable().optional(),
  aadhaarNumber: z.string().nullable().optional(),
  emergencyContactName: z.string().nullable().optional(),
  emergencyContactPhone: z.string().nullable().optional(),
  badgeNumber: z.string().nullable().optional(),
  skillCategory: z.string().nullable().optional(),
  wageBasis: z.string().nullable().optional(),
  contractorId: z.string().uuid().nullable().optional().or(z.literal('')),
  paymentMode: z.string().nullable().optional(),
  uanNumber: z.string().nullable().optional(),
  esicIpNumber: z.string().nullable().optional(),
  dateOfBirth: z.string().nullable().optional(),
  gender: z.string().nullable().optional(),
  commissionType: z.string().nullable().optional(),
  commissionValue: z.coerce.number().optional(),
});
const createPartySchema = z.object({ body: partyBody });
const updatePartySchema = z.object({ body: partyBody.partial().extend({ status: z.enum(['active', 'inactive']).optional() }) });

const labourWageProfileBody = z.object({
  dailyWagePaise: z.coerce.number().int().min(0),
  overtimeRateMultiplier: z.coerce.number().min(1).optional(),
  effectiveFrom: z.string().optional(),
});
const upsertLabourWageProfileSchema = z.object({ body: labourWageProfileBody });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  partyType: z.enum(['CUSTOMER', 'VENDOR', 'CONTRACTOR', 'LABOUR', 'SALES_REF']).optional(),
});

// FR-M04-2. stateCode is optional on input — the service derives it from the
// state name when omitted, since tax logic compares codes not free text.
const addressBody = z.object({
  label: z.string().min(1).optional(),
  contactPerson: z.string().optional(),
  phone: z.string().optional(),
  line1: z.string().min(1),
  line2: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  stateCode: z.string().regex(/^\d{2}$/).optional(),
  pincode: z.string().optional(),
  country: z.string().optional(),
  gstin: gstin.optional(),
  isBilling: z.boolean().optional(),
  isShipping: z.boolean().optional(),
  isDefaultBilling: z.boolean().optional(),
  isDefaultShipping: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
const createAddressSchema = z.object({ body: addressBody });
const updateAddressSchema = z.object({ body: addressBody.partial() });

module.exports = {
  GSTIN_PATTERN,
  createAddressSchema, updateAddressSchema, createPartySchema, updatePartySchema, upsertLabourWageProfileSchema, listQuerySchema };
