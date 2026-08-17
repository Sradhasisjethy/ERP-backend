const { z } = require('zod');

const partyBody = z.object({
  partyType: z.enum(['CUSTOMER', 'VENDOR', 'CONTRACTOR', 'LABOUR', 'SALES_REF']),
  name: z.string().min(1),
  code: z.string().optional(),
  gstin: z.string().optional(),
  phone: z.string().optional(),
  email: z.string().email().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  country: z.string().optional(),
  creditLimitPaise: z.coerce.number().int().min(0).optional(),
  creditAgeingDays: z.coerce.number().int().min(0).optional(),
  creditAction: z.enum(['NONE', 'WARN', 'BLOCK']).optional(),
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
  search: z.string().optional(),
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
  gstin: z.string().optional(),
  isBilling: z.boolean().optional(),
  isShipping: z.boolean().optional(),
  isDefaultBilling: z.boolean().optional(),
  isDefaultShipping: z.boolean().optional(),
  status: z.enum(['active', 'inactive']).optional(),
});
const createAddressSchema = z.object({ body: addressBody });
const updateAddressSchema = z.object({ body: addressBody.partial() });

module.exports = {
  createAddressSchema, updateAddressSchema, createPartySchema, updatePartySchema, upsertLabourWageProfileSchema, listQuerySchema };
