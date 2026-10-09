const { z } = require('zod');
const { MAX_STRING } = require('../../utils/zodFields');

// See organization.schema.js for why these are wrapped in `body:`.
const updateSettingSchema = z.object({
  body: z.object({
    value: z.any(),
    // The controller moves a setting between categories on update; validate()
    // now drops undeclared keys, so this has to be named here.
    category: z.string().max(MAX_STRING).optional(),
  }),
});

const createSettingSchema = z.object({
  body: z.object({
    key: z.string().min(1).max(MAX_STRING),
    value: z.any(),
    category: z.string().max(MAX_STRING).optional(),
  }),
});

const listSettingsQuerySchema = z.object({
  category: z.string().max(MAX_STRING).optional(),
});

module.exports = { updateSettingSchema, createSettingSchema, listSettingsQuerySchema };
