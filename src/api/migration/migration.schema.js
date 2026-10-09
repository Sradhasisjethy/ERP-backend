const { z } = require('zod');

// A migration file is the whole opening position in one request — the same
// 5,000-row ceiling the master-data import works to, not a document's 500.
const MAX_IMPORT_ROWS = 5000;

const KINDS = ['products', 'parties', 'openingStock', 'openingPartyBalances', 'openingCash'];

// Rows arrive as parsed objects (the client parses the spreadsheet), so the
// shape is deliberately loose here — MigrationService does the real,
// field-by-field validation and reports errors per row (FR-M29-2). Cells are
// still only what a spreadsheet can hold: an object or array in a cell used to
// be stored as '[object Object]'. Length is checked per row by the service so
// the error names the row; this bound only stops a pathological request.
const cell = z.union([z.string().max(10000), z.number(), z.boolean(), z.null()]);
const importSchema = z.object({
  body: z.object({
    kind: z.enum(KINDS),
    rows: z
      .array(z.record(z.string().max(100), cell).refine((row) => Object.keys(row).length <= 100, 'A row may have at most 100 columns'))
      .min(1)
      .max(MAX_IMPORT_ROWS),
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
