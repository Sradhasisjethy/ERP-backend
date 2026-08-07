const { z } = require('zod');

const updateSettingSchema = z.object({
  value: z.any(),
});

const createSettingSchema = z.object({
  key: z.string().min(1),
  value: z.any(),
  category: z.string().optional(),
});

const listSettingsQuerySchema = z.object({
  category: z.string().optional(),
});

module.exports = { updateSettingSchema, createSettingSchema, listSettingsQuerySchema };
