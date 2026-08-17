const { z } = require('zod');

const gstrQuerySchema = z.object({
  factoryId: z.string().uuid(),
  fromDate: z.string(),
  toDate: z.string(),
});

module.exports = { gstrQuerySchema };
