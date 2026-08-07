const { z } = require('zod');

// See organization.schema.js for why these are wrapped in `body:`.
const updateSettingSchema = z.object({
  body: z.object({
    value: z.any(),
  }),
});

const createSettingSchema = z.object({
  body: z.object({
    key: z.string().min(1),
    value: z.any(),
    category: z.string().optional(),
  }),
});

const listSettingsQuerySchema = z.object({
  category: z.string().optional(),
});

module.exports = { updateSettingSchema, createSettingSchema, listSettingsQuerySchema };
