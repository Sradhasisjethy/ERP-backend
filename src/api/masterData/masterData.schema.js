const { z } = require('zod');

/**
 * Only the import history is validated here.
 *
 * The export and validate endpoints take module-specific filters (status,
 * partyType, priceListId, ...) and each config decides which query keys it
 * reads, so a schema listing them all would have to be edited every time a
 * master is added — and would be the copy that goes stale. The workbook itself
 * is not described by zod either: its rules live in the column definitions,
 * which are also what writes the sample file, so the two cannot disagree.
 */
const runsQuerySchema = z.object({
  module: z.string().trim().min(1).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(10),
});

module.exports = { runsQuerySchema };
