const { z } = require('zod');
const { listQuery } = require('../../utils/pagination');
const { MAX_RESPONSE_DAYS } = require('./privacy.constants');

const PRINCIPAL_TYPES = ['USER', 'PARTY', 'LEAD', 'OTHER'];
const REQUEST_TYPES = ['ACCESS', 'CORRECTION', 'ERASURE', 'NOMINATION', 'GRIEVANCE', 'CONSENT_WITHDRAWAL'];
const CHANNELS = ['IN_APP', 'PUBLIC_FORM', 'EMAIL', 'WRITTEN', 'PHONE'];
const CONSENT_METHODS = ['IN_APP', 'WEB_FORM', 'WRITTEN', 'EMAIL', 'VERBAL_RECORDED'];
const RELATIONS = ['SELF', 'NOMINEE', 'GUARDIAN', 'AUTHORISED'];

const text = (max) => z.string().trim().max(max);
const optionalText = (max) => text(max).optional().nullable();
const email = z.string().trim().email().max(160);
const phone = z.string().trim().regex(/^[0-9+\-\s()]{6,20}$/, 'phone must be 6-20 digits');
const dateTime = z.string().datetime({ offset: true });

const purposeSchema = z.object({
  code: z.string().trim().regex(/^[A-Z][A-Z0-9_]{1,59}$/, 'purpose code must be UPPER_SNAKE_CASE'),
  label: text(120).min(1),
  description: text(1000).min(1),
  dataItems: z.array(text(80).min(1)).min(1).max(40),
  principalTypes: z.array(z.enum(PRINCIPAL_TYPES)).min(1).max(4),
  lawfulBasis: z.enum(['CONSENT', 'LEGITIMATE_USE']),
  legalReference: optionalText(300),
  retention: optionalText(300),
  optional: z.boolean().optional(),
});

const processorSchema = z.object({
  name: text(160).min(1),
  purpose: text(300).min(1),
  location: optionalText(120),
});

const noticeFields = {
  title: text(200).min(1),
  language: text(40).min(1).optional(),
  summary: optionalText(4000),
  body: optionalText(50000),
  purposes: z.array(purposeSchema).max(40)
    .refine((list) => new Set(list.map((p) => p.code)).size === list.length, 'purpose codes must be unique'),
  processors: z.array(processorSchema).max(40),
};

const profileSchema = z.object({
  body: z.object({
    contactName: optionalText(120),
    contactDesignation: optionalText(120),
    contactEmail: email.optional().nullable(),
    contactPhone: phone.optional().nullable(),
    postalAddress: optionalText(1000),
    responseDays: z.coerce.number().int().min(1).max(MAX_RESPONSE_DAYS).optional(),
    dataLocation: optionalText(200),
    isSignificantDataFiduciary: z.boolean().optional(),
  }),
});

const createNoticeSchema = z.object({ body: z.object(noticeFields).partial() });
const updateNoticeSchema = z.object({ body: z.object(noticeFields).partial() });

const consentSchema = z.object({
  body: z.object({
    // The organisation that holds the person's record (the desk spans them all).
    tenantId: z.string().uuid(),
    principalType: z.enum(PRINCIPAL_TYPES),
    principalId: z.string().uuid().optional().nullable(),
    principalName: optionalText(160),
    principalContact: optionalText(160),
    purposeCode: z.string().trim().min(1).max(60),
    method: z.enum(CONSENT_METHODS),
    evidence: optionalText(2000),
    isMinor: z.boolean().optional(),
    guardianName: optionalText(160),
    guardianRelation: optionalText(60),
    guardianVerification: optionalText(1000),
  }).refine((b) => b.principalType === 'OTHER' || b.principalId, { message: 'principalId is required for this record type' }),
});

const withdrawSchema = z.object({ body: z.object({ reason: optionalText(1000) }) });

const consentListSchema = listQuery({
  tenantId: z.string().uuid().optional(),
  principalType: z.enum(PRINCIPAL_TYPES).optional(),
  principalId: z.string().uuid().optional(),
  purposeCode: z.string().trim().max(60).optional(),
  status: z.enum(['GRANTED', 'WITHDRAWN']).optional(),
});

const requestFields = {
  type: z.enum(REQUEST_TYPES),
  requesterName: text(160).min(1),
  requesterEmail: email.optional().nullable().or(z.literal('')),
  requesterPhone: phone.optional().nullable().or(z.literal('')),
  requesterRelation: z.enum(RELATIONS).optional(),
  details: optionalText(4000),
};

const createRequestSchema = z.object({
  body: z.object({
    ...requestFields,
    channel: z.enum(CHANNELS),
    tenantId: z.string().uuid().optional().nullable(),
    requesterOrganisation: optionalText(160),
    principalType: z.enum(PRINCIPAL_TYPES).optional().nullable(),
    principalId: z.string().uuid().optional().nullable(),
  }),
});

const updateRequestSchema = z.object({
  body: z.object({
    tenantId: z.string().uuid().optional(),
    principalType: z.enum(PRINCIPAL_TYPES).optional().nullable(),
    principalId: z.string().uuid().optional().nullable(),
    assignedTo: z.string().uuid().optional().nullable(),
    details: optionalText(4000),
  }),
});

const verifySchema = z.object({ body: z.object({ note: text(1000).min(3) }) });
const rejectSchema = z.object({ body: z.object({ reason: text(2000).min(3) }) });

const nomineeFields = z.object({
  nomineeName: text(160).min(1),
  relationship: optionalText(60),
  nomineeEmail: email.optional().nullable().or(z.literal('')),
  nomineePhone: phone.optional().nullable().or(z.literal('')),
});

const completeSchema = z.object({
  body: z.object({
    resolution: optionalText(4000),
    purposeCode: z.string().trim().max(60).optional(),
    nominee: nomineeFields.optional(),
  }),
});

const requestListSchema = listQuery({
  tenantId: z.string().uuid().optional(),
  status: z.enum(['RECEIVED', 'VERIFYING', 'IN_PROGRESS', 'COMPLETED', 'REJECTED']).optional(),
  type: z.enum(REQUEST_TYPES).optional(),
  openOnly: z.enum(['true', 'false']).optional(),
  overdueOnly: z.enum(['true', 'false']).optional(),
});

const exportQuerySchema = z.object({
  tenantId: z.string().uuid(),
  principalType: z.enum(['USER', 'PARTY', 'LEAD']),
  principalId: z.string().uuid(),
});

/** From a signed-in user about themselves. Principal and channel are implied. */
const myRequestSchema = z.object({
  body: z.object({
    type: z.enum(REQUEST_TYPES),
    details: optionalText(4000),
  }),
});

const myNomineeSchema = z.object({ body: z.object({ nominee: nomineeFields.nullable() }) });

const myConsentSchema = z.object({ body: z.object({ purposeCode: z.string().trim().min(1).max(60) }) });

/** The public form. Contact is required: it is the only way to answer. */
const publicRequestSchema = z.object({
  body: z.object({
    ...requestFields,
    type: z.enum(REQUEST_TYPES),
    // Which business they deal with: the notice is the platform's, so the owner
    // needs this to find the organisation that holds their record.
    requesterOrganisation: optionalText(160),
    // Honeypot: a person never sees this field, so anything in it is a bot.
    website: z.string().max(200).optional(),
  }).refine((b) => b.requesterEmail || b.requesterPhone, { message: 'Give an email address or phone number so we can reply' }),
});

const breachFields = {
  title: text(200).min(1),
  description: text(5000).min(1),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  occurredAt: dateTime.optional().nullable(),
  discoveredAt: dateTime,
  containedAt: dateTime.optional().nullable(),
  cause: optionalText(5000),
  dataCategories: z.array(text(80).min(1)).max(40).optional(),
  principalCategories: z.array(text(80).min(1)).max(20).optional(),
  affectedCount: z.coerce.number().int().min(0).max(100000000).optional().nullable(),
  likelyConsequences: optionalText(5000),
  mitigation: optionalText(5000),
  safetyMeasures: optionalText(5000),
};

const createBreachSchema = z.object({ body: z.object(breachFields) });
const updateBreachSchema = z.object({ body: z.object(breachFields).partial() });
const breachStepSchema = z.object({
  body: z.object({
    step: z.enum(['BOARD_INTIMATED', 'BOARD_REPORT_SUBMITTED', 'PRINCIPALS_NOTIFIED', 'CONTAINED']),
    at: dateTime.optional(),
    reference: optionalText(120),
    method: optionalText(200),
  }),
});

const retentionUpdateSchema = z.object({
  body: z.object({
    retentionDays: z.coerce.number().int().min(1).max(36500).optional(),
    enabled: z.boolean().optional(),
  }),
});

module.exports = {
  profileSchema,
  createNoticeSchema,
  updateNoticeSchema,
  consentSchema,
  withdrawSchema,
  consentListSchema,
  createRequestSchema,
  updateRequestSchema,
  verifySchema,
  rejectSchema,
  completeSchema,
  requestListSchema,
  exportQuerySchema,
  myRequestSchema,
  myNomineeSchema,
  myConsentSchema,
  publicRequestSchema,
  createBreachSchema,
  updateBreachSchema,
  breachStepSchema,
  retentionUpdateSchema,
};
