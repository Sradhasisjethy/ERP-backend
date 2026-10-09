const { z } = require('zod');
const { MAX_STRING, MAX_SEARCH } = require('../../utils/zodFields');

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  entityType: z.string().max(MAX_STRING).optional(),
  entityId: z.string().uuid().optional(),
  userId: z.string().uuid().optional(),
});

module.exports = { listQuerySchema };
