const { z } = require('zod');

const KINDS = ['products', 'parties', 'openingStock', 'openingPartyBalances', 'openingCash'];

// Rows arrive as parsed objects (the client parses the spreadsheet), so the
// shape is deliberately loose here — MigrationService does the real,
// field-by-field validation and reports errors per row (FR-M29-2).
const importSchema = z.object({
  body: z.object({
    kind: z.enum(KINDS),
    rows: z.array(z.record(z.any())).min(1),
    dryRun: z.boolean().optional(),
  }),
});

const reconcileSchema = z.object({
  body: z.object({
    kind: z.enum(KINDS),
    controlTotals: z.record(z.any()).optional(),
  }),
});

module.exports = { importSchema, reconcileSchema, KINDS };
