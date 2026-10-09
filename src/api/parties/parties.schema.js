const { z } = require('zod');
const { isoDate, isIsoDate, MAX_STRING, MAX_TEXT, MAX_SEARCH, MAX_PAISE } = require('../../utils/zodFields');
const { isMaskedValue } = require('./partySensitive');

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

// The identity/bank fields (pan, aadhaarNumber, bankAccountNumber, bankIfsc,
// esic/uan, dateOfBirth, ...) are deliberately free strings: the edit form sends
// back the masked '••••••••1234' it was shown, and PartiesService drops those as
// "unchanged". A format regex here would reject the form before that happens.
// dateOfBirth is the one exception: it must be a real date or the mask. The
// labour age and Aadhaar checks live in PartiesService, after masks are dropped.
const dateOfBirth = z.string().max(MAX_STRING).refine(
  (value) => isMaskedValue(value) || isIsoDate(value),
  'dateOfBirth must be a date in YYYY-MM-DD format'
);

const partyBody = z.object({
  partyType: z.enum(['CUSTOMER', 'VENDOR', 'CONTRACTOR', 'LABOUR', 'SALES_REF']),
  name: z.string().min(1).max(MAX_STRING),
  code: z.string().max(MAX_STRING).optional(),
  gstin: gstin.optional(),
  phone: z.string().trim().min(6).max(20).optional(),
  email: z.string().email().max(MAX_STRING).optional(),
  address: z.string().max(MAX_TEXT).optional(),
  city: z.string().max(MAX_STRING).optional(),
  state: z.string().max(MAX_STRING).optional(),
  country: z.string().max(MAX_STRING).optional(),
  gstType: z.string().max(MAX_STRING).nullable().optional(),
  legalName: z.string().max(MAX_STRING).nullable().optional(),
  creditLimitPaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE).optional(),
  creditAgeingDays: z.coerce.number().int().min(0).finite().optional(),
  creditAction: z.enum(['NONE', 'WARN', 'BLOCK']).optional(),
  openingBalance: z.coerce.number().finite().optional(),
  asOfDate: isoDate.nullable().optional(),
  paymentTerms: z.string().max(MAX_STRING).nullable().optional(),
  pincode: z.string().max(MAX_STRING).nullable().optional(),
  billingAddress: z.string().max(MAX_TEXT).nullable().optional(),
  creditPeriodDays: z.coerce.number().int().min(0).finite().optional(),
  noOfCredits: z.coerce.number().int().min(0).finite().optional(),
  relationshipSince: z.string().max(MAX_STRING).nullable().optional(),
  distanceKm: z.coerce.number().finite().optional(),
  transportation: z.string().max(MAX_STRING).nullable().optional(),
  balanceType: z.string().max(MAX_STRING).nullable().optional(),
  pan: z.string().max(MAX_STRING).nullable().optional(),
  msmeCategory: z.string().max(MAX_STRING).nullable().optional(),
  udyamNumber: z.string().max(MAX_STRING).nullable().optional(),
  tdsApplicable: z.coerce.boolean().optional(),
  tdsSection: z.string().max(MAX_STRING).nullable().optional(),
  bankAccountNumber: z.string().max(MAX_STRING).nullable().optional(),
  bankIfsc: z.string().max(MAX_STRING).nullable().optional(),
  bankName: z.string().max(MAX_STRING).nullable().optional(),
  bankBranch: z.string().max(MAX_STRING).nullable().optional(),
  beneficiaryName: z.string().max(MAX_STRING).nullable().optional(),
  pfCode: z.string().max(MAX_STRING).nullable().optional(),
  esicNumber: z.string().max(MAX_STRING).nullable().optional(),
  laborLicenseNumber: z.string().max(MAX_STRING).nullable().optional(),
  workCategory: z.string().max(MAX_STRING).nullable().optional(),
  retentionPercent: z.coerce.number().min(0).max(100).finite().optional(),
  entityType: z.string().max(MAX_STRING).nullable().optional(),
  aadhaarNumber: z.string().max(MAX_STRING).nullable().optional(),
  emergencyContactName: z.string().max(MAX_STRING).nullable().optional(),
  emergencyContactPhone: z.string().max(MAX_STRING).nullable().optional(),
  badgeNumber: z.string().max(MAX_STRING).nullable().optional(),
  skillCategory: z.string().max(MAX_STRING).nullable().optional(),
  wageBasis: z.string().max(MAX_STRING).nullable().optional(),
  contractorId: z.string().uuid().nullable().optional().or(z.literal('')),
  paymentMode: z.string().max(MAX_STRING).nullable().optional(),
  uanNumber: z.string().max(MAX_STRING).nullable().optional(),
  esicIpNumber: z.string().max(MAX_STRING).nullable().optional(),
  dateOfBirth: dateOfBirth.nullable().optional(),
  gender: z.string().max(MAX_STRING).nullable().optional(),
  commissionType: z.string().max(MAX_STRING).nullable().optional(),
  commissionValue: z.coerce.number().finite().optional(),
});
const createPartySchema = z.object({ body: partyBody });
const updatePartySchema = z.object({ body: partyBody.partial().extend({ status: z.enum(['active', 'inactive']).optional() }) });

const labourWageProfileBody = z.object({
  dailyWagePaise: z.coerce.number().int().min(0).finite().max(MAX_PAISE),
  overtimeRateMultiplier: z.coerce.number().min(1).finite().optional(),
  effectiveFrom: isoDate.optional(),
});
const upsertLabourWageProfileSchema = z.object({ body: labourWageProfileBody });

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  status: z.enum(['active', 'inactive']).optional(),
  partyType: z.enum(['CUSTOMER', 'VENDOR', 'CONTRACTOR', 'LABOUR', 'SALES_REF']).optional(),
  /**
   * Several kinds at once, comma separated — `VENDOR,CONTRACTOR,LABOUR`.
   *
   * A payment goes to a vendor, a contractor or a labourer, and the picker for
   * it says exactly that. With only the single `partyType` filter the screen
   * had to ask for every party and offer customers on a money-out form.
   */
  partyTypes: z
    .string()
    .trim()
    .min(1)
    .optional()
    .transform((value) => (value ? value.split(',').map((part) => part.trim()).filter(Boolean) : undefined))
    .refine(
      (types) => !types || types.every((type) => ['CUSTOMER', 'VENDOR', 'CONTRACTOR', 'LABOUR', 'SALES_REF'].includes(type)),
      { message: 'partyTypes must be a comma separated list of party types' }
    ),
});

// FR-M04-2. stateCode is optional on input — the service derives it from the
// state name when omitted, since tax logic compares codes not free text.
const addressBody = z.object({
  label: z.string().min(1).max(MAX_STRING).optional(),
  contactPerson: z.string().max(MAX_STRING).optional(),
  phone: z.string().max(MAX_STRING).optional(),
  line1: z.string().min(1).max(MAX_STRING),
  line2: z.string().max(MAX_STRING).optional(),
  city: z.string().max(MAX_STRING).optional(),
  state: z.string().max(MAX_STRING).optional(),
  stateCode: z.string().regex(/^\d{2}$/).optional(),
  pincode: z.string().max(MAX_STRING).optional(),
  country: z.string().max(MAX_STRING).optional(),
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
