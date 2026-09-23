const { z } = require('zod');

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Dates are YYYY-MM-DD');
const SOURCES = ['WALK_IN', 'PHONE', 'REFERRAL', 'SITE_VISIT', 'TENDER', 'ONLINE', 'EXHIBITION', 'OTHER'];

const leadFields = {
  name: z.string().trim().min(1).max(160),
  contactName: z.string().trim().max(120).optional().nullable(),
  phone: z.string().trim().max(20).optional().nullable(),
  email: z.string().trim().email().max(160).optional().nullable().or(z.literal('')),
  city: z.string().trim().max(80).optional().nullable(),
  state: z.string().trim().max(60).optional().nullable(),
  source: z.enum(SOURCES).optional(),
  estimatedValuePaise: z.coerce.number().int().min(0).optional().nullable(),
  expectedCloseDate: isoDate.optional().nullable(),
  ownerId: z.string().uuid().optional().nullable(),
  requirement: z.string().max(2000).optional().nullable(),
};

const createLeadSchema = z.object({ body: z.object(leadFields) });

const updateLeadSchema = z.object({
  body: z.object({ ...leadFields, name: leadFields.name.optional() }),
});

const statusSchema = z.object({
  body: z.object({
    // QUOTED and WON are not here on purpose: they follow from quoting the
    // lead and from converting it, not from someone picking them.
    status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'LOST']),
    reason: z.string().trim().max(1000).optional(),
  }),
});

const convertSchema = z.object({
  body: z.object({ customerPartyId: z.string().uuid().optional() }),
});

const activitySchema = z.object({
  body: z.object({
    type: z.enum(['NOTE', 'CALL', 'MEETING', 'EMAIL', 'SITE_VISIT', 'TASK']),
    subject: z.string().trim().min(1).max(200),
    detail: z.string().max(2000).optional(),
    occurredAt: z.string().optional(),
    dueDate: isoDate.optional(),
    assignedTo: z.string().uuid().optional(),
  }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  status: z.enum(['NEW', 'CONTACTED', 'QUALIFIED', 'QUOTED', 'WON', 'LOST']).optional(),
  openOnly: z.enum(['true', 'false']).optional(),
  ownerId: z.string().uuid().optional(),
  source: z.enum(SOURCES).optional(),
  search: z.string().trim().min(1).optional(),
});

const taskQuerySchema = z.object({
  assignedTo: z.string().uuid().optional(),
  dueBefore: isoDate.optional(),
});

module.exports = { createLeadSchema, updateLeadSchema, statusSchema, convertSchema, activitySchema, listQuerySchema, taskQuerySchema, SOURCES };
