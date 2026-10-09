const { z } = require('zod');
const { isoDate } = require('../../utils/zodFields');

const gstrQuerySchema = z.object({
  factoryId: z.string().uuid(),
  fromDate: isoDate,
  toDate: isoDate,
});

module.exports = { gstrQuerySchema };
