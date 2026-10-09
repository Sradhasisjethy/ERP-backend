const { z } = require('zod');

// One list, owned by the service, so the schema and the counter can't drift.
const { DENOMINATIONS, MAX_DENOMINATION_COUNT } = require('./cashRegister.service');

// { "500": 10, "100": 4 } — note value to how many. Counts are whole notes.
// Keys are limited to real notes/coins: the count can drive a Cash Short /
// Excess journal at close, so "1e12": 1 must not reach the books.
const denominationsBody = z.record(
  z.enum(DENOMINATIONS.map(String), {
    errorMap: () => ({ message: `Denomination must be one of ${DENOMINATIONS.join(', ')}` }),
  }),
  z.coerce.number().int().min(0).max(MAX_DENOMINATION_COUNT)
);

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
