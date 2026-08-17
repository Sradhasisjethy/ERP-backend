const { z } = require('zod');
const { NOTIFICATION_TYPES } = require('./notification.model');

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  search: z.string().trim().min(1).optional(),
  sortBy: z.string().trim().min(1).optional(),
  sortDir: z.enum(['asc', 'desc']).optional(),
  unreadOnly: z.enum(['true', 'false']).optional(),
  type: z.enum(NOTIFICATION_TYPES).optional(),
  severity: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  factoryId: z.string().uuid().optional(),
});

module.exports = { listQuerySchema };
