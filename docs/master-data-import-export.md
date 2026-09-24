# Master Data Import / Export

Phase 1 (discovery) and Phase 2 (architecture) of the Excel import/export work.
Written before any code changed, and kept as the developer guide afterwards.

---

## A. Existing architecture

| Layer | What is actually there |
| --- | --- |
| Frontend | React 19 + Vite 6, **plain JSX — no TypeScript anywhere**. react-router 6, TanStack Query 5, TanStack Table 8, Tailwind + Radix primitives (`src/components/ui`), zustand for UI state, `sonner` for toasts, axios (`src/lib/api-client.js`) with a refresh-token interceptor. Tests: Vitest + React Testing Library. |
| Backend | Node + Express 4, layered `router -> middleware -> controller -> service -> model`. One folder per domain under `src/api/<domain>/`, files named `<domain>.router.js` / `.controller.js` / `.service.js` / `.schema.js` and `<entity>.model.js`. Tests: Jest + supertest against a real Postgres. |
| Database | Postgres via Sequelize 6. Multi-tenant through CLS (`cls-hooked`, namespace `erp-tenant-namespace`); `Sequelize.useCLS` is on, so a query inside a `sequelize.transaction()` callback joins that transaction automatically. Money is **BIGINT paise**, quantities `DECIMAL(14,4)`. |
| Auth | Cookie/bearer JWT, `authenticate` -> `tenantScope` -> `auditContext` on every domain router. |
| RBAC | `src/utils/permissionCatalog.js` is the single source of truth. Codes are `<RESOURCE>_<ACTION>` for CRUD, plus named **grants** for anything that is not CRUD (`VIEW_RATES`, `PURCHASE_APPROVE`, `MIGRATION_RUN`, `REPORT_*_EXPORT`). `authorize('X')` gates routes; PLATFORM_ADMIN / TENANT_OWNER bypass. |
| Validation | zod schemas per module, applied by `middlewares/validate.js`. |
| Audit | `BaseAuditedModel` writes an `audit_logs` row with before/after snapshots on every create and update — **automatically**, as long as the write goes through the model. |
| Errors | `core/AppError` (`ValidationError`, `ConflictError`, `NotFoundError`, ...) rendered by `utils/response.js`. |

## B. Master data inventory

| Module | Table | Existing API | Service (reused by the importer) | Business key | Import | Export |
| --- | --- | --- | --- | --- | --- | --- |
| Products | `products` | `/api/v1/products` | `ProductsService.createProduct/updateProduct` | `code` (unique index) | yes | yes |
| Product Categories | `product_categories` | `/api/v1/product-categories` | `ProductsService.createProductCategory/updateProductCategory` | `code` (app-enforced) | yes | yes |
| Units of Measure | `uoms` | `/api/v1/uoms` | `ProductsService.createUom/updateUom` | `code` (unique index) | yes | yes |
| HSN / SAC Codes | `hsn_codes` | `/api/v1/hsn-codes` | `ProductsService.createHsnCode/updateHsnCode` | `code` (unique index) | yes | yes |
| Parties | `parties` | `/api/v1/parties` | `PartiesService.createParty/updateParty` | `code` (app-enforced) | yes | yes |
| Vehicles | `vehicles` | `/api/v1/vehicles` | `VehiclesService.create/update` | `registrationNumber` (unique index) | yes | yes |
| Chart of Accounts | `accounts` | `/api/v1/ledger/accounts` | `AccountsService.create/update` | `code` (unique index) | yes | yes |
| Price List Items | `price_list_items` | `/api/v1/price-lists/:id` | `PricingService.updatePriceList` | `priceListId` + product `code` | yes (per list) | yes (per list) |
| Leave Types | `leave_types` | `/api/v1/hr/leave-types` | `HrService.createLeaveType/updateLeaveType` | `code` (unique index) | yes | yes |
| Offices | `offices` | `/api/v1/offices` | `OrganizationService.createOffice/updateOffice` | `code` | yes | yes |
| Departments | `departments` | `/api/v1/departments` | `OrganizationService.createDepartment/updateDepartment` | `code` | yes | yes |
| Employees | `employees` | `/api/v1/users` | — | `email` | **no — see limitations** | yes |
| Mix Designs / Bundles | `mix_designs`, `bundles` | various | — | — | no — versioned parent/child documents, not flat masters | no |
| Factories, Financial Years, Document Series | — | — | — | — | no — a handful of rows, set up once | no |

## C. Existing infrastructure that is reused (not rebuilt)

| Need | Reused |
| --- | --- |
| Excel writing | `exceljs` 4.4 — already a dependency, already used by `src/api/reports/export/xlsx.js` |
| Excel reading | `exceljs` (same package reads `.xlsx`) |
| File upload | `multer` 1.4 — already a dependency (`src/api/users/user.router.js`) |
| Business rules | the master services listed above — the importer is a second input channel into them, never a second write path |
| Audit trail | `BaseAuditedModel` -> `audit_logs`, automatic per record |
| RBAC | `permissionCatalog.js` grants + `authorize()` |
| Formula-injection guard | the `=`/`+`/`-`/`@` prefix rule already in `src/utils/exporter.js` |
| Rate masking | `VIEW_RATES` / BR-27, the same rule report export applies |
| List/paging contract | `utils/pagination.js` + the frontend `usePaginated` hook |
| Table action area | `DataTable`'s existing `actionsNode` prop — the buttons drop straight in |
| File download in the browser | `src/lib/api-document.js` (blob over axios, so credentials and the 401 refresh both work) |
| Prior art for import | `src/api/migration/` — go-live opening balances, CSV pasted in the browser, validate-all-then-commit |

## D. Gaps

1. No generic, per-master import/export — `migration/` covers five go-live kinds only, is CSV-only, is create-only, and is gated on the one-time `MIGRATION_RUN`.
2. No Excel **reading** anywhere; no `.xlsx` parse, no file-level validation.
3. No sample/template generation.
4. No upsert (detect existing vs new), no preview-then-commit, no error workbook.
5. No import-run record: nothing says who imported what file, when, or with what result.
6. No `_IMPORT` / `_EXPORT` permissions.
7. Frontend has no Excel library and no file-upload component; **no new frontend dependency is needed** — the server produces and consumes the workbooks and the browser only moves bytes.

### Deliberate decisions

- **Match precedence is `ID` then business key.** Every export carries a locked `ID` column; a file that came from our export updates exactly the rows it came from even where the business code is blank or was edited. A hand-built file has no `ID` column and matches on the business key alone. (Requirement 17: never match on name.)
- **A code is required to import** Parties and Product Categories, whose `code` is nullable in the schema. Making the column required in the template gives those masters a reliable business key without a schema change or a data backfill.
- **Atomic by default.** Validation errors block the whole commit; nothing is written until every row passes. Partial import is not offered for master data.
- **Money columns are rupees in the sheet, paise in the database.** A user without `VIEW_RATES` gets a template and an export with no money columns at all (BR-27 — a blank column still leaks that a value exists), and on import their money cells are ignored with a warning shown in the preview rather than silently.
- **Template downloads are gated on the module's `_READ`**, not on a separate permission: an empty template is a list of column names, which a user who may open the screen can already see.

---

## E. Architecture

```
Master data screen
        |
  MasterImportExportActions           src/components/master-data/import-export-actions.jsx
        |            \
  MasterImportDialog   download       src/components/master-data/import-dialog.jsx
        |                             src/hooks/use-master-data.js, src/lib/api-document.js
        v
  POST /master-data/:module/import/validate      (multipart, <= 5 MB, .xlsx)
        |
  masterData.router.js   authenticate -> tenantScope -> auditContext
        |                -> <RESOURCE>_IMPORT / _EXPORT / _READ
        |                -> multer (memory) with the tenant context bound
        v
  MasterDataService.validate
        |-- excel.readWorkbook      file, sheet and column checks
        |-- lookups.loadLookups     one query per referenced master
        |-- columns.coerce          type, length, range, enum, date, reference
        |-- duplicate detection     inside the file, and against the database
        |-- decideAction            NEW / UPDATE / UNCHANGED / SKIP / ERROR
        v
  master_import_runs row  (the checked rows, held server-side)
        |
  POST /master-data/imports/:importId/commit
        v
  MasterDataService.commit
        |-- re-resolve every match  (the data may have moved on)
        |-- sequelize.transaction
        |     ProductsService.createProduct / updateProduct
        |     PartiesService.createParty / updateParty      <- the same services
        |     VehiclesService.create / update                  the dialogs call
        |     AccountsService, HrService, OrganizationService, PricingService
        |         |
        |         v
        |     BaseAuditedModel -> audit_logs (BR-30, per record)
        v
  run updated: COMMITTED, created/updated counts, duration
```

Files, and what each is responsible for:

| File | Responsibility |
| --- | --- |
| `src/api/masterData/columns.js` | what a cell means: coercion, validation, export formatting, rule text |
| `src/api/masterData/excel.js` | the only file that knows what a worksheet is — template, export, error report, reader |
| `src/api/masterData/lookups.js` | code to id maps for reference columns, one query per master per import |
| `src/api/masterData/registry.js` | the list of modules, in dependency order, and their permissions |
| `src/api/masterData/configs/*.config.js` | one object per master: columns, examples, load, create, update |
| `src/api/masterData/masterData.service.js` | the engine: validate, commit, error workbook, history, pruning |
| `src/api/masterData/importRun.model.js` | `master_import_runs` — the audit record and the validate/commit bridge |
| `src/components/master-data/import-export-actions.jsx` | the three buttons, permission-aware |
| `src/components/master-data/import-dialog.jsx` | sample, upload, check, preview, confirm |
| `src/hooks/use-master-data.js` | one hook set for every module |

## F. Developer guide — adding a master

1. **Write a config** in `src/api/masterData/configs/`. The required keys:

   ```js
   {
     key: 'shifts',                     // the URL segment
     label: 'Shifts',
     fileBase: 'Shifts',                // Shifts_Sample.xlsx, Shifts_2026-09-24.xlsx
     resource: 'SHIFT',                 // the permission prefix
     businessKey: 'code',               // the field a row is matched on
     businessKeyHeader: 'Shift Code',   // how to name it in an error
     columns: [ ... ],                  // see below
     examples: [ {...}, {...} ],        // two worked rows, keyed by field
     load: async ({ query, context }) => Model.findAll({ ... }),
     create: (values) => Service.create(values),
     update: (record, values) => Service.update(record.id, values),
   }
   ```

   Optional: `dependsOn` (a sentence about import order), `notes` (extra
   Instructions rows), `skipRow`, `checkUpdate`, `context`, `commitAll`,
   `keyOf` / `keyFromValues`, `ratesRequired`.

2. **Describe each column.** `header` is the exact spreadsheet heading; `field`
   is what the service expects. `type` is one of `text`, `code`, `email`,
   `number`, `integer`, `money`, `boolean`, `date`, `enum`, `reference`. Add
   `required`, `maxLength`, `min`, `max`, `pattern` and `note` as needed.
   `rate: true` marks a money column for BR-27, `readOnly: true` is the ID
   column, and `exportOnly: true` writes a column that is never read back.

   A `reference` column needs `reference: { master: 'uoms', label: '...' }`,
   and `lookups.js` needs a loader registered under that name.

3. **Register it** in `registry.js`, in dependency order — after everything it
   references.

4. **Add the permissions.** Wrap the resource in `withImportExport(...)` in
   `src/utils/permissionCatalog.js`, and mirror the two codes in the frontend
   `src/constants/enums.js`.

5. **Put the buttons on the screen:**

   ```jsx
   <MasterImportExportActions
     module="shifts" label="Shifts" resource="SHIFT"
     filters={{ status, ...(searchValue ? { search: searchValue } : {}) }}
   />
   ```

6. **Write the tests.** `tests/master-data-import-export.test.js` is the
   pattern; the cases worth copying are the atomic rollback, the duplicate
   inside one file, and the permission boundaries.

There is deliberately nothing to write for the sample file, the export, the
preview dialog, the error workbook or the audit trail. They all come from the
config.

## G. API

All under `/api/v1/master-data`, all behind `authenticate -> tenantScope -> auditContext`.

| Method | Path | Permission | Purpose |
| --- | --- | --- | --- |
| GET | `/modules` | authenticated | What can be imported and exported, and under which permissions |
| GET | `/:module/template` | `<RESOURCE>_READ` | The sample workbook: columns, two examples, Instructions sheet |
| GET | `/:module/export` | `<RESOURCE>_EXPORT` | The whole filtered set as .xlsx; query params are the screen filters |
| POST | `/:module/import/validate` | `<RESOURCE>_IMPORT`, plus `_CREATE`/`_MODIFY` as the file requires | Multipart `file`, optional `importMode`. Writes nothing; returns the preview |
| POST | `/imports/:importId/commit` | same | Writes the checked run, in one transaction |
| GET | `/imports/:importId` | `<RESOURCE>_IMPORT` | The preview again |
| GET | `/imports/:importId/errors` | `<RESOURCE>_IMPORT` | The failed rows as .xlsx, ready to fix and re-upload |
| GET | `/imports` | authenticated | Recent runs: who, which file, what it did |

`importMode` is `UPSERT` (the default), `CREATE` or `UPDATE`.

## H. Limits and performance

| | |
| --- | --- |
| File size | 5 MB |
| Rows per file | 5,000 |
| Sheets per workbook | 10 |
| Sheet read | `Data`, or the first sheet if there is none by that name |
| Preview rows returned | 500, errors first; the error workbook carries them all |
| Run payload retention | 7 days, after which the rows are dropped and the run record is kept |

### Measured, 1,000 new products

Taken against a Postgres on another host, **28.9 ms round trip**:

| Phase | Time | SQL round trips |
| --- | --- | --- |
| validate | 0.8 s | 7 total — not per row |
| commit (create) | 69 s | 2,006 — 2 per row |
| commit (update) | 96 s | 3,006 — 3 per row |
| validate, nothing changed | 0.7 s | 7 total |

**Validation does not scale with round trips and is effectively free.** It reads
the workbook in memory, loads each referenced master once, and loads the
existing records once — seven queries whether the file has ten rows or five
thousand.

**The commit is entirely round-trip bound.** Every row is written through the
module own service, the same one the New/Edit dialog calls. Left to itself that
service re-checks, for every single row, what the importer has just established
for the whole file in one query each:

```
1. does this code already exist?          <- the importer already knows
2. does this UoM exist?                    <- already resolved from a map
3. does this category exist?               <- already resolved from a map
4. does this HSN code exist?               <- already resolved from a map
5. INSERT the product                      <- the actual work
6. INSERT its audit row (BR-30)            <- the actual work
```

So the master services take an optional `preVerified`, and only the importer
passes it (`ProductsService.createProduct` documents the contract). With it, a
created product costs **two** round trips instead of six, and an updated one
three instead of six — the remaining three being the fetch, the write and the
audit row, none of which can be skipped.

It weakens nothing. Both skipped checks were reads followed by a write, so the
real guarantee was always the unique index and the foreign keys, and those still
run: anything the importer got wrong surfaces as a constraint violation and
rolls the entire import back. Every screen and every other caller leaves the
option alone and keeps the checks.

| 1,000 products | Round trips per created row | At 29 ms |
| --- | --- | --- |
| before `preVerified` | 6 (4 with no category or HSN) | 2-3 minutes |
| after | 2, whatever the file names | ~60 seconds |

The estimate shown in the preview is not this formula: after a module has been
imported once, it uses what that module actually cost last time, so it stays
right as the services change.

### What this means in practice

Time is `rows x queries-per-row x round-trip`. The round trip dominates
everything else, so the same code is fast or slow depending only on where the
database is:

| Where the database is | Round trip | 1,000 products |
| --- | --- | --- |
| Another host over the internet (a laptop against cloud Postgres) | ~29 ms | 2-3 minutes |
| Same region, different host | ~2 ms | ~10 seconds |
| Same machine or same data centre | ~0.3 ms | ~2 seconds |

The spread within a row is the file itself: a products file naming a category
and an HSN code costs six round trips per row, one naming neither costs four.
The estimate shown in the preview counts the references the file actually uses,
which is why it lands within a second or two of the real time.

A developer importing against a remote database sees minutes. The same import
on a deployed server sees seconds. Nothing in the code changes.

The preview measures the round trip when it checks the file and states the
expected commit time before anything is written, so a two-minute wait is never
mistaken for a hang.

### If it needs to be faster than that

Two levers, in the order they are worth pulling:

1. **Put the application next to the database.** Worth roughly 15x, costs no
   code, and is the difference between minutes and seconds.
2. **Done:** the services skip the checks the importer has already made, via the
   optional `preVerified` argument above. Worth 3x on creates, 2x on updates.
   What is left per row — the write and its audit row — cannot go without either
   losing the record or losing BR-30.

A background job with a progress channel was considered and not built. It would
not make the import faster — only the waiting invisible — and it adds a job
runner, a progress channel and a new class of half-finished state to a write
path whose whole design is that it either completes or does nothing.

## I. User guide

1. **Download the sample** — or **Export Excel**, to edit what is already there.
   The Instructions sheet lists every column and its rule.
2. **Edit it in Excel.** Keep the columns exactly as they are. Delete the example
   rows. Leave the `ID` column alone — it is how an exported row finds its record
   again. Amounts are in rupees, dates are DD/MM/YYYY, and Yes/No columns take
   Yes or No.
3. **Import Excel, choose the file, press Check this file.** Nothing is saved yet.
4. **Read the preview.** It says how many records are new, how many change and
   what changes about them, how many already match, and which rows are wrong.
5. **If there are errors**, download the failed rows, fix them in that file and
   upload it again. A file with any error cannot be imported at all.
6. **Press Import.** Everything lands together, or nothing does.

Two things worth telling an operations user once:

- **A blank optional cell means "leave this as it is"**, not "clear it".
- **Rows you do not want to touch can simply be deleted from the file.** An
  export of 400 products, cut down to the 12 whose price changed, changes 12.
