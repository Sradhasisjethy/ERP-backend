const { z } = require('zod');

// { "500": 10, "100": 4 } — note value to how many. Counts are whole notes.
const denominationsBody = z.record(z.string(), z.coerce.number().int().min(0));

const openSessionSchema = z.object({
  body: z.object({
    factoryId: z.string().uuid(),
    accountId: z.string().uuid().optional(),
    denominations: denominationsBody.optional(),
    note: z.string().max(1000).optional(),
  }),
});

const closeSessionSchema = z.object({
  body: z.object({
    denominations: denominationsBody.optional(),
    note: z.string().max(1000).optional(),
    // Write the counted difference to the books so the cash account matches
    // the drawer. Off by default: a difference is worth looking at first.
    postAdjustment: z.boolean().optional(),
  }),
});

const listQuerySchema = z.object({
  page: z.coerce.number().min(1).default(1),
  limit: z.coerce.number().min(1).max(100).default(10),
  factoryId: z.string().uuid().optional(),
  status: z.enum(['OPEN', 'CLOSED']).optional(),
});

const currentQuerySchema = z.object({
  factoryId: z.string().uuid(),
  accountId: z.string().uuid().optional(),
});

module.exports = { openSessionSchema, closeSessionSchema, listQuerySchema, currentQuerySchema };
