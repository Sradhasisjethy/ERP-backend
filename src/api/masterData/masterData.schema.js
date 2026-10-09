const { z } = require('zod');
const { MAX_SEARCH } = require('../../utils/zodFields');

/**
 * The workbook itself is not described by zod: its rules live in the column
 * definitions, which are also what writes the sample file, so the two cannot
 * disagree.
 */

/**
 * Filters for export and import/validate.
 *
 * These used to go to the configs as raw `req.query`, so `?status[$ne]=x`
 * arrived as an object and `?status=a&status=b` as an array, straight into a
 * where clause. This is the union of every key a config reads (grep
 * `query.` in configs/) — one list, so a new filter is a one-line addition
 * here, and anything else is refused rather than passed along. Every value is
 * a scalar string, ids are uuids, and enum filters take the stored values the
 * list endpoints already accept, so a bad one is a 400 and not a Postgres
 * "invalid input value for enum" 500.
 */
const masterQuerySchema = z
  .object({
    search: z.string().trim().max(MAX_SEARCH).optional(),
    status: z.enum(['active', 'inactive', 'maintenance', 'blacklisted']).optional(),
    includeInactive: z.enum(['true', 'false']).optional(),
    organizationId: z.string().uuid().optional(),
    officeId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(),
    priceListId: z.string().uuid().optional(),
    partyType: z.enum(['CUSTOMER', 'VENDOR', 'CONTRACTOR', 'LABOUR', 'SALES_REF']).optional(),
    productType: z.enum(['FINISHED_GOOD', 'RAW_MATERIAL']).optional(),
    vehicleType: z.enum(['TRUCK', 'TRAILER', 'TIPPER', 'TRANSIT_MIXER', 'PICKUP', 'OTHER']).optional(),
    ownership: z.enum(['OWNED', 'HIRED', 'MARKET', 'ATTACHED']).optional(),
    // Read by the controller, not the configs; the service checks the value.
    importMode: z.enum(['UPSERT', 'CREATE', 'UPDATE']).optional(),
  })
  .strict();

const runsQuerySchema = z.object({
  module: z.string().trim().min(1).max(64).optional(),
  page: z.coerce.number().finite().int().min(1).default(1),
  limit: z.coerce.number().finite().int().min(1).max(100).default(10),
});

module.exports = { runsQuerySchema, masterQuerySchema };
