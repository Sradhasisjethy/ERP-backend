const { z } = require('zod');
const { MAX_SEARCH } = require('../../utils/zodFields');
const { NOTIFICATION_TYPES } = require('./notification.model');

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).finite().default(1),
  limit: z.coerce.number().min(1).max(100).finite().default(10),
  search: z.string().trim().min(1).max(MAX_SEARCH).optional(),
  sortBy: z.string().trim().min(1).max(64).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
  type: z.enum(NOTIFICATION_TYPES).optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  factoryId: z.string().uuid().optional(),
});

module.exports = { listQuerySchema };
