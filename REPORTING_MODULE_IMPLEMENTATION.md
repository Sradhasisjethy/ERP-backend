# Reporting Module — Implementation Report

Manufacturing ERP · Reports redesign · August 2026

---

## 0. A correction to the brief

The brief describes this system as **MongoDB**. It is not. The backend runs
**PostgreSQL 8.11 via Sequelize 6.35**, with 18 SQL migrations, `sequelize-cli`,
and a fully relational schema (69 models, 53 pre-existing indexes, real foreign
keys and unique constraints).

Everything the brief asks for in Mongo terms has a direct relational equivalent,
and that is what was built:

| Brief (MongoDB) | Implemented (PostgreSQL) |
| --- | --- |
| Aggregation pipeline | SQL with `GROUP BY`, `FILTER (WHERE …)`, `LATERAL` joins, window functions |
| `$lookup` | `JOIN` / `LEFT JOIN LATERAL` |
| `$match` placement | Predicates pushed into the innermost subquery that can use an index |
| "Do not allow arbitrary MongoDB sort/filter fields" | Per-report `sortMap` allow-list; every value bound as `$n`, never interpolated |
| Index review | New migration adding 28 reporting indexes |

No other part of the brief was affected by the correction.

---

## 1. Existing architecture analysis

### 1.1 What the Reports module was

The entire pre-existing module was **435 lines** across five files.

```
src/api/reports/
  reports.service.js     71 lines   RUNNERS map: 11 keys -> existing service methods
  reports.controller.js 109 lines   MASKERS map + CSV/PDF export handler
  reportColumns.js      146 lines   column lists for 8 of the 11 report types
  reports.router.js      24 lines   7 routes, all gated by one REPORT_READ
  savedReport.model.js   47 lines   name + reportType enum + params JSONB
```

`ReportsService.run()` was a dispatch table. Each entry forwarded to a method
that already existed elsewhere:

```js
STOCK_AGEING:  (p) => AnalyticsService.getStockAgeing(p.factoryId, {...}),
TRIAL_BALANCE: (p) => LedgerService.getTrialBalance(p.factoryId),
GSTR1:         (p) => GstrService.getGstr1(p.factoryId, {...}),
```

That is a naming and scheduling layer over eleven existing endpoints — which is
what its own header comment said it was ("not a general query engine"). It was
never a reporting subsystem.

### 1.2 Frontend

`ReportsPage.jsx` (276 lines) rendered results as:

```jsx
<pre className="…">{JSON.stringify(result, null, 2)}</pre>
```

The sidebar's Reports group had nine entries: two marked `soon: true`, five
aliasing the same builder page with a different `?report=` value.

### 1.3 Problems found

| # | Problem | Evidence | Severity |
| --- | --- | --- | --- |
| P1 | **Location scope not enforced.** `params.factoryId` was passed straight into every runner. `getAllowedFactoryIds` / `applyFactoryFilter` — which exist and are used by other modules — were never called in the reports module. | `reports.service.js` RUNNERS; no import of `core/factoryAccess` | **Critical** — a user assigned to Factory A could read Factory B's sales, cash and stock by passing its id |
| P2 | **No pagination.** Only `PARTY_LEDGER` paginated. `STOCK_AGEING`, `TRIAL_BALANCE`, `CASH_BOOK`, `GSTR1` returned every matching row in one response. | `RUNNERS` return shapes | **High** — unbounded response growth |
| P3 | **No filtering.** No date range, customer, product, status or location filter on any report. | `PARAM_FIELDS` in `ReportsPage.jsx` | High |
| P4 | **No search, no sorting.** Neither existed on any report. | — | High |
| P5 | **Raw JSON as the UI.** | `ReportsPage.jsx` line 209 | High |
| P6 | **CSV, not Excel.** The exporter's own comment justified this ("xlsx needs a heavy dependency"). No formatting, no column widths, no totals, no freeze panes. | `utils/exporter.js` | Medium |
| P7 | **PDF truncated data.** Fixed `usable / cols.length` column widths with `ellipsis: true` — a long customer name was silently cut. No page numbers, no totals row, header redrawn but no wrapping. | `utils/exporter.js#toPdf` | Medium |
| P8 | **One coarse permission.** `REPORT_READ` gated everything from stock ageing to the trial balance. No export-specific grant. | `reports.router.js` | Medium |
| P9 | **Business logic duplicated per format.** `flattenForExport` re-derived each report's row shape separately from how it was produced. | `reportColumns.js` | Medium |
| P10 | **Dead navigation.** `Day Book`, `Cash Flow`, `Receivables`, `Payables`, `Stock Adjustment`, `Wage` were all `soon: true` placeholders. | `constants/navigation.js` | Low |

### 1.4 Infrastructure that was reused, not rebuilt

Everything below already existed and is production-quality. The new module is
built on it rather than beside it.

| Existing asset | How the Reports module uses it |
| --- | --- |
| `core/BaseModel.js` — CLS tenant auto-scoping | Organisation isolation for all ORM access |
| `core/factoryAccess.js` — `getAllowedFactoryIds` | Location scope; mirrored for raw SQL in `SqlWhere.factoryScope` |
| `middlewares/authorize.js` — `hasPermission` | Per-report permission checks |
| `utils/permissionCatalog.js` | Extended with 22 new codes; the role editor picks them up with no change |
| `utils/fieldMasking.js` — `hasViewRates` (BR-27) | Money-column stripping |
| `utils/pagination.js` — `toOrder` allow-list pattern | The model for `sortMap` |
| `utils/response.js` — `sendList` envelope | Report responses use the same envelope every list endpoint uses |
| `utils/money.js` — integer paise (BR-17) | All money arithmetic |
| `inventory/ageing.service.js` — `resolveThresholds`, `GLOBAL_DEFAULTS` | Ageing policy, imported not restated |
| `payments.service.js` — `getInvoiceAllocatedAmount` | Replicated exactly in SQL as `fragments.allocatedAmount` |
| `ledger/systemAccounts.js` | Cash/bank account codes for cash flow |
| Frontend `usePaginated`, `DataTable`, `StatCard`, shadcn/ui, TanStack Query | Conventions followed; `DataTable` kept for every other module |

No duplicate table, filter, pagination, export, permission, API-client, date or
currency utility was created.

---

## 2. Target architecture

### 2.1 Backend

```
Request  GET /api/v1/reports/sales/summary?dateFrom=…&customerId=…&sortBy=netPaise
   │
   ├─ authenticate ─ tenantScope (CLS tenantId) ─ auditContext
   │
   ├─ validate(reportQuerySchema)        strict allow-list; unknown keys rejected
   │
   ├─ resolveReport(category, slug)      registry lookup + per-report permission
   │
   └─ executeReport(definition, req, params)
        │
        ├─ buildContext        tenantId (CLS) + getAllowedFactoryIds(req)
        ├─ visibleColumns      drop columns the user's grants do not cover
        ├─ definition.build    returns { from, select, where(SqlWhere), sortMap, … }
        ├─ buildOrderBy        sortBy resolved against sortMap; else report default
        │
        ├─ COUNT query         SELECT COUNT(*) FROM (SELECT 1 FROM … WHERE …)
        ├─ DATA query          SELECT … LIMIT $n OFFSET $n
        └─ SUMMARY query       same FROM + same WHERE, no LIMIT
             │
             └─ strip denied keys from every row and from the summary
```

The same `executeReport` serves the screen and all three export formats. The
only difference is the page size:

```
screen   mode:'page'    limit = min(200, requested)
export   mode:'export'  limit = REPORT_EXPORT_MAX_ROWS, page 1
```

That is structural, not a convention — there is no second code path that could
drift.

### 2.2 File layout

```
src/api/reports/
  lib/
    registry.js     defineReport / getReportByPath / CATEGORIES / FILTER_KEYS
    sqlWhere.js     bind-parameter WHERE builder; tenant + factory scoping
    columns.js      column & metric vocabulary; field-level permission filtering
    fragments.js    SQL shared across reports (allocated amount, ageing bucket, …)
    filters.js      filter descriptors served to the client
    runner.js       executeReport — the single execution path
  definitions/
    sales.js orders.js purchase.js production.js inventory.js
    ageing.js parties.js labour.js finance.js analytics.js
    index.js        requires all of the above (registration is a side effect)
  export/
    format.js       type-driven value formatting + org currency/locale settings
    xlsx.js         exceljs workbook
    pdf.js          PDFKit renderer
    index.js        orchestration; CSV; filter-label resolution
  reports.controller.js  catalog / meta / data / export + the M40 saved-report API
  reports.router.js
  reports.schema.js
```

### 2.3 Frontend

```
/reports/:category/:report
   │
   ├─ useReportCatalog()   categories + reports this user may open
   ├─ useReportMeta()      columns, filter controls, search fields, limitations
   └─ useReportData()      rows + count + summary + the columns it was rendered against

ReportsPage
 ├─ ReportCategoryTabs      14 category tabs
 ├─ ReportPicker            reports in the active category, as chips
 ├─ ReportToolbar           search · filters · More filters · columns · export
 ├─ ReportLimitations       what this report cannot show, and why
 ├─ ReportSummary           server-computed tiles (whole result set)
 ├─ ReportTable             sticky header, typed cells, server-side sort
 └─ ReportPagination        server-side, with rows-per-page
```

**All filter state lives in the URL.** `/reports/sales/summary?dateFrom=2026-08-01&customerId=…&sortBy=netPaise&sortDir=desc`
is bookmarkable and shareable. The URL carries the *question*; the recipient's
own permissions and locations still decide the *answer*.

---

## 3. Report catalog

**46 reports across 14 categories.** Route prefix `/api/v1/reports`.

| Category | Report | Route | Cols | Filters | Search | Sortable | Tiles | View permission |
| --- | --- | --- | --: | --: | --: | --: | --: | --- |
| Sales | Sales Summary | /sales/summary | 15 | 8 | 3 | 13 | 7 | REPORT_SALES_READ |
| Sales | Sales Detail | /sales/detail | 13 | 7 | 4 | 13 | 5 | REPORT_SALES_READ |
| Sales | Sales by Customer | /sales/by-customer | 10 | 4 | 2 | 10 | 6 | REPORT_SALES_READ |
| Sales | Sales by Product | /sales/by-product | 9 | 7 | 2 | 9 | 5 | REPORT_SALES_READ |
| Sales | Sales by Location | /sales/by-location | 9 | 3 | 2 | 9 | 5 | REPORT_SALES_READ |
| Orders | Sales Order Report | /orders/sales-orders | 14 | 7 | 3 | 13 | 5 | REPORT_ORDER_READ |
| Orders | Pending Order Report | /orders/pending | 15 | 8 | 3 | 14 | 4 | REPORT_ORDER_READ |
| Purchase | Purchase Summary | /purchase/summary | 14 | 5 | 4 | 13 | 5 | REPORT_PURCHASE_READ |
| Purchase | Purchase Detail | /purchase/detail | 12 | 7 | 4 | 11 | 3 | REPORT_PURCHASE_READ |
| Purchase | Purchase by Vendor | /purchase/by-vendor | 8 | 4 | 2 | 8 | 5 | REPORT_PURCHASE_READ |
| Purchase | Purchase by Product | /purchase/by-product | 8 | 7 | 2 | 8 | 3 | REPORT_PURCHASE_READ |
| Production | Production Summary | /production/summary | 15 | 6 | 3 | 13 | 5 | REPORT_PRODUCTION_READ |
| Production | Raw Material Consumption | /production/consumption | 14 | 6 | 3 | 12 | 5 | REPORT_PRODUCTION_READ |
| Production | Production by Contractor | /production/by-contractor | 9 | 6 | 2 | 9 | 5 | REPORT_PRODUCTION_READ |
| Inventory | Current Stock | /inventory/current-stock | 15 | 7 | 2 | 14 | 5 | REPORT_INVENTORY_READ |
| Inventory | Stock Movement | /inventory/movement | 13 | 7 | 4 | 12 | 4 | REPORT_INVENTORY_READ |
| Inventory | Stock Transfer Report | /inventory/transfers | 13 | 6 | 3 | 13 | 5 | REPORT_INVENTORY_READ |
| Inventory | Stock Adjustment Report | /inventory/adjustments | 10 | 6 | 4 | 9 | 4 | REPORT_INVENTORY_READ |
| Inventory | Stock Reconciliation | /inventory/reconciliation | 10 | 4 | 2 | 9 | 4 | REPORT_INVENTORY_READ |
| Stock Ageing | Stock Ageing | /ageing/stock-ageing | 16 | 7 | 3 | 16 | 7 | REPORT_INVENTORY_READ |
| Stock Ageing | Dead Stock | /ageing/dead-stock | 16 | 6 | 3 | 16 | 5 | REPORT_INVENTORY_READ |
| Stock Ageing | Slow Moving Stock | /ageing/slow-moving | 16 | 6 | 3 | 16 | 5 | REPORT_INVENTORY_READ |
| Customer | Customer Ledger | /customer/ledger | 9 | 5 | 3 | 8 | 4 | REPORT_CUSTOMER_READ |
| Customer | Customer Summary | /customer/summary | 12 | 5 | 4 | 12 | 5 | REPORT_CUSTOMER_READ |
| Customer | Customer Outstanding | /customer/outstanding | 11 | 5 | 3 | 11 | 6 | REPORT_CUSTOMER_READ |
| Vendor | Vendor Ledger | /vendor/ledger | 9 | 5 | 3 | 8 | 4 | REPORT_VENDOR_READ |
| Vendor | Vendor Summary | /vendor/summary | 10 | 5 | 4 | 10 | 5 | REPORT_VENDOR_READ |
| Vendor | Vendor Outstanding | /vendor/outstanding | 11 | 5 | 3 | 11 | 6 | REPORT_VENDOR_READ |
| Contractor | Contractor Ledger | /contractor/ledger | 9 | 5 | 3 | 8 | 4 | REPORT_CONTRACTOR_READ |
| Contractor | Contractor Production | /contractor/production | 13 | 7 | 3 | 12 | 4 | REPORT_CONTRACTOR_READ |
| Contractor | Contractor Outstanding | /contractor/outstanding | 9 | 5 | 2 | 8 | 4 | REPORT_CONTRACTOR_READ |
| Labour | Labour Ledger | /labour/ledger | 9 | 5 | 3 | 8 | 4 | REPORT_LABOUR_READ |
| Labour | Labour Attendance | /labour/attendance | 8 | 5 | 2 | 7 | 6 | REPORT_LABOUR_READ |
| Labour | Labour Wage Report | /labour/wages | 11 | 4 | 2 | 11 | 5 | REPORT_LABOUR_READ |
| Payments | Payment Register | /payment/register | 12 | 7 | 3 | 11 | 5 | REPORT_FINANCE_READ |
| Payments | Payment Mode Report | /payment/modes | 11 | 5 | 2 | 11 | 6 | REPORT_FINANCE_READ |
| Payments | Collection Report | /payment/collections | 9 | 5 | 3 | 8 | 3 | REPORT_FINANCE_READ |
| Expenses | Expense Report | /expense/register | 9 | 7 | 3 | 8 | 5 | REPORT_FINANCE_READ |
| Expenses | Expense by Category | /expense/by-category | 7 | 5 | 1 | 6 | 3 | REPORT_FINANCE_READ |
| Finance | Receivables | /finance/receivables | 11 | 5 | 3 | 11 | 6 | REPORT_FINANCE_READ |
| Finance | Payables | /finance/payables | 11 | 5 | 3 | 11 | 6 | REPORT_FINANCE_READ |
| Finance | Cash Flow | /finance/cash-flow | 7 | 4 | 0 | 6 | 4 | REPORT_FINANCE_READ |
| Finance | Day Book | /finance/day-book | 10 | 6 | 4 | 9 | 4 | REPORT_FINANCE_READ |
| Analytics | Business Summary | /analytics/business-summary | 0 | 3 | 0 | 0 | 9 | REPORT_ANALYTICS_READ |
| Analytics | Location Performance | /analytics/location-performance | 10 | 3 | 2 | 10 | 6 | REPORT_ANALYTICS_READ |
| Analytics | Product Performance | /analytics/product-performance | 12 | 6 | 2 | 12 | 5 | REPORT_ANALYTICS_READ |

Every report supports search (where it has meaningful searchable fields),
server-side sorting, server-side pagination, and Excel / PDF / CSV export.

### 3.1 Deliberate merges

The brief lists reports that describe the same business data. Shipping both
would be the duplication the redesign exists to remove, so these were merged:

| Brief | Merged into | Why |
| --- | --- | --- |
| 5.13 Production Summary + 5.16 Finished Goods Production | `production/summary` | Both are `production_entries`, plan against actual. `rejectedQty` is a column on the one report. |
| 5.14 Production Detail + 5.15 Raw Material Consumption | `production/consumption` | Both are the `material_consumptions` rows of an entry. |
| 5.23 Stock Ageing + 5.24 Dead Stock + 5.25 Slow Moving | one query, three registry entries | Identical rows, thresholds and value arithmetic; only the band differs. Three menu entries, one code path. |
| 5.28 Customer Outstanding + 5.45 Receivables | one `buildReceivables`, registered twice | Same open invoices, same ageing. Finance and Sales both need it under their own tab. |
| 5.31 Vendor Outstanding + 5.46 Payables | one `buildPayables`, registered twice | As above. |
| 5.27 / 5.30 / 5.33 / 5.37 party ledgers | one `buildPartyLedger(partyType, convention)` | Same journal query; the party type and the debit/credit convention are parameters. |

---

## 4. Report definition architecture

A report is one object. Nothing about it is declared anywhere else.

```js
defineReport({
  id: 'sales-summary',
  category: 'sales',
  slug: 'summary',
  name: 'Sales Summary',
  description: 'One row per sales invoice, with tax, collection and what is still outstanding.',
  dateFieldLabel: 'Invoice Date',
  limitations: [ /* what this report cannot show, and why */ ],

  filters:      ['dateFrom','dateTo','factoryId','customerId','productId','categoryId','status','paymentStatus'],
  searchFields: ['Invoice No', 'Customer Name', 'Customer Code'],
  defaultSort:  { by: 'invoiceDate', dir: 'desc' },

  columns: [
    code('invoiceNumber', 'Invoice No'),
    date('invoiceDate', 'Invoice Date'),
    money('netPaise', 'Net Amount', { total: true }),   // implies requires: VIEW_RATES
    status('paymentStatus', 'Payment Status'),
    …
  ],
  summary: [ metric('invoiceCount', 'Invoices', 'int'), metric('netPaise', 'Net Sales') ],

  build({ params, tenantId, allowedFactoryIds, where }) {
    const w = where('si."tenantId"');            // tenant predicate already applied
    w.factoryScope('si."factoryId"', allowedFactoryIds, params.factoryId);
    w.dateRange('si."invoiceDate"', params.dateFrom, params.dateTo);
    w.search(['si."invoiceNumber"', 'c."name"', 'c."code"'], params.search);
    return { from, select, where: w, sortMap, tieBreak, summarySelect };
  },
});
```

### 4.1 Column types

| Type | Alignment | Screen | Excel | PDF/CSV |
| --- | --- | --- | --- | --- |
| `money` | right | `₹1,23,456.00` | number + `"₹"##,##,##0.00` | grouped number, currency in header |
| `qty` | right | up to 4 dp | number + `##,##,##0.####` | grouped |
| `int` | right | grouped | number + `##,##,##0` | grouped |
| `percent` | right | `12.50%` | number + `0.00"%"` | `12.50%` |
| `date` | left | `05-Aug-2026` | real date + `dd-mmm-yyyy` | `05-Aug-2026` |
| `status` | left | coloured badge + label | humanised text | humanised text |
| `code` | left | medium weight | text | text |
| `text` | left | truncated with title | wrapped text | wrapped |

`type: 'money'` **implies** `requires: 'VIEW_RATES'`. A report author cannot
forget BR-27 on a money column, because declaring it money *is* declaring it
restricted.

---

## 5. Filter system

The server publishes each report's filter controls; the UI renders what it is
told. This is why a "Status" dropdown on Customer Summary offers
Active/Inactive while the one on Sales Order Report offers the order lifecycle —
without a per-report component.

```js
// Served with every report definition
{ key: 'status', label: 'Status', control: 'select',
  options: [{ value: 'CONFIRMED', label: 'Confirmed' }, …], primary: true }
```

| Control | Rendered as | Fed by |
| --- | --- | --- |
| `date` | date input | — |
| `entity` | select | existing list endpoints (`/factories`, `/parties?partyType=…`, `/products`, `/product-categories`) |
| `select` | select | server-supplied vocabulary |
| `text` | text input | — |
| `toggle` | checkbox | — |

**23 filter keys** exist module-wide (`FILTER_KEYS`); a report opts into only
the ones that apply to it — 3 for Sales by Location, 8 for Sales Summary.
`primary: true` filters stay on screen; the rest fold behind **More filters**
with a count badge so a hidden active filter still announces itself.

Declaring a filter key that has no descriptor throws at module load, so a
report cannot ship with a filter the UI would not know how to render.

---

## 6. API specification

```
GET  /api/v1/reports/catalog                         categories + reports the caller may open
GET  /api/v1/reports/:category/:report/meta          definition only (no query run)
GET  /api/v1/reports/:category/:report               one page + summary
GET  /api/v1/reports/:category/:report/export        the whole filtered set as a file
```

Route ordering is deliberate: literal `/catalog` and the saved-report collection
routes precede the parameterised ones, and the catalog's two-segment shape
(`/sales/summary`) is unambiguous against the saved-report API's one-segment
`/:id`.

### 6.1 Request parameters

Validated by a **strict** Zod schema — unknown keys are rejected with 400, not
ignored.

```
page  limit  search  sortBy  sortDir
dateFrom  dateTo                                      (YYYY-MM-DD; dateFrom <= dateTo enforced)
factoryId  customerId  vendorId  contractorId  labourId  partyId  productId  categoryId   (UUID)
status  paymentStatus  movementType  referenceType  productType  stockStatus
ageingClass  attendanceStatus  expenseCategory  paymentMode  direction  accountKey
overdueOnly
format                                                (export only: xlsx | pdf | csv)
```

`sortBy` is a free string in the schema because the valid set is per-report; it
is resolved against that report's `sortMap` in the runner and silently falls
back to the report's default if unrecognised.

### 6.2 Response

```json
{
  "success": true,
  "message": "Report generated successfully",
  "data": {
    "rows": [ … ],
    "count": 1240, "page": 1, "limit": 25, "totalPages": 50,
    "summary": { "invoiceCount": 1240, "netPaise": 284000000 },
    "columns": [ { "key": "netPaise", "header": "Net Amount", "type": "money", "align": "right", "sortable": true, "total": true } ],
    "metrics": [ { "key": "netPaise", "label": "Net Sales", "type": "money" } ],
    "sort": { "by": "invoiceDate", "dir": "desc" },
    "report": { "id": "sales-summary", "filterControls": [ … ], "limitations": [ … ], "canExport": true }
  }
}
```

Uses the same `sendList` envelope every other list endpoint in the system uses.
`columns` is the list the response **was rendered against** — a client renders
what the server allowed, not a list it decided for itself.

### 6.3 Saved-report API (M40) — unchanged

`GET/POST /reports`, `POST /reports/run`, `POST /reports/export`,
`GET/DELETE /reports/:id`, `POST /reports/:id/run` all behave exactly as before.
No existing consumer was broken.

---

## 7. Export architecture

```
GET /reports/sales/summary/export?format=xlsx&dateFrom=…&customerId=…
   │
   ├─ resolveReport(..., { forExport: true })    REPORT_<CATEGORY>_EXPORT required
   ├─ executeReport(definition, req, params, { mode: 'export' })
   │     └─ identical definition, filters, WHERE, and column stripping
   │     └─ refuses above REPORT_EXPORT_MAX_ROWS with an actionable message
   ├─ resolveFormatSettings()      org currency/locale from tenant_settings
   ├─ describeFilters()            UUIDs -> names ("Customer: Zeta Constructions")
   └─ xlsx | pdf | csv renderer
```

### 7.1 Excel (`exceljs`)

The output is a **working spreadsheet**, not a grid of strings — numeric cells
hold numbers with a number format, so the reader can re-sort, re-total and
pivot. That is what the previous CSV could not do.

- Title block: organisation · report · description · period · location · applied filters · currency · generated-by
- Summary tiles as label/value pairs, correctly formatted
- Bold header on a fill, wrapped, aligned per column type
- **Freeze panes** above and including the header row
- **Auto-filter** across the data range
- Banded rows, thin borders
- **Totals row using `SUM()` formulas**, not precomputed constants, so the figure survives the reader deleting a row
- Column widths measured from actual content (10–46 chars)
- Landscape + fit-to-width page setup for wide reports; header repeats on every printed page
- Sheet name sanitised (Excel rejects `: \ / ? * [ ]`, caps at 31 chars)

### 7.2 PDF (`pdfkit`)

Rewritten to fix P7. The failure modes it is written to avoid:

| Failure | Prevention |
| --- | --- |
| Text clipped with an ellipsis | Cells wrap; row height measured from the tallest wrapped cell |
| Rows split across a page break | A row that does not fit moves whole to the next page |
| Header vanishing on page 2 | Redrawn on every page |
| No page numbers | Pages buffered; footer written afterwards as "Page X of Y" |
| Columns overlapping / dropped | Reports too wide even for landscape are split into **column groups**, rendered one after another, each repeating the identifying first column. Nothing is dropped or clipped. |
| Currency unreadable | PDFKit's built-in fonts are WinAnsi-encoded and have **no ₹ glyph**. Amounts are grouped numbers; the header states the currency once. |

Landscape above 6 columns; font 7.5pt / 7pt / 6.5pt by column count.

### 7.3 CSV

Retained for tooling that wants it. UTF-8 BOM so Excel reads Indian names
correctly, CRLF line endings, and the **formula-injection guard** from the
original exporter (`=`, `+`, `-`, `@` prefixed with a quote).

### 7.4 Large exports

There is **no durable job queue** in this deployment — `jobs/scheduler.js` is a
single in-process timer that dies with the process and does not coordinate
across replicas. Rather than pretend otherwise, exports run inline up to
`REPORT_EXPORT_MAX_ROWS` (default **50,000**, configurable) and are refused
above it:

> This export would contain 84,120 rows, over the 50,000-row limit. Narrow the
> date range or add a filter, then try again.

The count is checked **before a single row is rendered**, so an oversized
request costs one `COUNT(*)` rather than a partial file. See §16 for the
asynchronous design this should become.

---

## 8. Permission architecture

Extends the existing catalog; the role editor picks the new codes up with no
frontend change because it reads the live catalog from the API.

```
REPORT_SALES_READ        REPORT_SALES_EXPORT
REPORT_ORDER_READ        REPORT_ORDER_EXPORT
REPORT_PURCHASE_READ     REPORT_PURCHASE_EXPORT
REPORT_PRODUCTION_READ   REPORT_PRODUCTION_EXPORT
REPORT_INVENTORY_READ    REPORT_INVENTORY_EXPORT      (inventory + stock ageing)
REPORT_CUSTOMER_READ     REPORT_CUSTOMER_EXPORT
REPORT_VENDOR_READ       REPORT_VENDOR_EXPORT
REPORT_CONTRACTOR_READ   REPORT_CONTRACTOR_EXPORT
REPORT_LABOUR_READ       REPORT_LABOUR_EXPORT
REPORT_FINANCE_READ      REPORT_FINANCE_EXPORT        (finance + payments + expenses)
REPORT_ANALYTICS_READ    REPORT_ANALYTICS_EXPORT
```

22 codes; 130 total in the catalog. **Export is a named grant, not a CRUD
action** — for the same reason `PURCHASE_APPROVE` is: downloading a whole
filtered result set is a materially different act from reading one page of it,
and must not come along with read access.

### 8.1 Three independent layers

| Layer | Enforced by | Effect |
| --- | --- | --- |
| **Organisation** | `tenantId` from CLS, injected into every report's WHERE by `SqlWhere.forTenant` | Another tenant's rows cannot be reached |
| **Location** | `getAllowedFactoryIds` + `SqlWhere.factoryScope` | Restricted to assigned factories; an explicit out-of-scope `factoryId` returns **403**, not empty |
| **Field** | `visibleColumns` / `visibleMetrics` in the runner | Columns the caller may not see are **removed from the payload**, not nulled |

Field-level security runs **inside the runner**, before either the JSON
serializer or an export renderer sees a row. There is no path that could
re-add a denied field.

### 8.2 Why removal, not blanking

A column full of blanks still tells the reader that a number exists and how many
rows have one. FR-M27-3 asks for the column to be absent. So a user without
`VIEW_RATES` receives a `columns` array with no money columns *and* row objects
with those keys deleted — `'netPaise' in row === false`.

---

## 9. Database and query design

### 9.1 The rule that shapes every definition

> A bind parameter must be introduced in `spec.from` or `spec.where` — **never**
> in `spec.select`.

The count query is `SELECT 1 FROM … WHERE …` and drops the select list entirely.
Postgres rejects a Bind message that supplies more parameters than the statement
references, so a `$n` appearing only in the select list makes the count query
fail at runtime. Correlated per-row work therefore goes in a `LATERAL` join
(part of FROM), not a select-list subquery. This was caught by the smoke harness
and two reports were restructured because of it.

### 9.2 Techniques used

| Technique | Where | Why |
| --- | --- | --- |
| `LEFT JOIN LATERAL` | invoice paid-amount, line aggregates, per-location metrics | One pass; keeps parameters in FROM; lets each subquery use its own index |
| `FILTER (WHERE …)` | opening/in/out split, present/absent day counts | One scan instead of three correlated subqueries |
| Window functions | running balances (stock movement, party ledger, day book), cash-flow cumulative opening, expense % of total | Computed over the whole filtered set **before** LIMIT, so a running balance stays continuous across pages |
| `DISTINCT` key list + LATERAL | Current Stock | Avoids grouping the entire stock ledger |
| Deterministic tiebreaker | every report | Without one, two rows with the same date can swap between page 1 and page 2 — a row seen twice or never |

### 9.3 Index migration

`20260826000000-reporting-indexes.js` adds **28 indexes**, idempotently (matching
the convention earlier phase migrations set).

Every report filters on `(tenantId, factoryId, <business date>)` — that is the
module's entire query surface. Before this, the transactional tables carried
only their document-number unique index, so a date-ranged report on a busy
factory meant a sequential scan. Line tables get `(tenantId, parentId)` and
`(tenantId, productId)`, because foreign keys do not create indexes in Postgres.

```
sales_invoices (tenantId, factoryId, invoiceDate) · (tenantId, customerPartyId)
sales_invoice_lines (tenantId, salesInvoiceId) · (tenantId, productId)
sales_orders, sales_order_lines, purchase_invoices, goods_receipts,
goods_receipt_lines, delivery_challans, production_entries,
material_consumptions, contractor_production_entries,
stock_ledger_entries (tenantId, factoryId, productId, createdAt) · (tenantId, movementType),
stock_lots, stock_transfers (both directions), stock_transfer_lines,
receipts, payments, expenses (+ category), journal_lines, attendance_records
```

### 9.4 Data consistency

Every figure is derived from the transactional rows themselves. No summary
table, no cached aggregate, nothing to fall out of sync.

| Report figure | Same rule as |
| --- | --- |
| Invoice paid-to-date | `payments.service.js#getInvoiceAllocatedAmount` — POSTED receipts *and* payments, replicated exactly in `fragments.allocatedAmount` |
| Stock balances | `StockLedgerService.rebuildStockBalances` reconstructs lot balances from the same ledger rows the reports read |
| Ageing thresholds | `AgeingService.resolveThresholds` — Product → Category → Factory → Global, per field. `GLOBAL_DEFAULTS` is **imported**, not restated |
| Party dues | The books: contractors/labour credit AP when they earn, debit it when paid (`workforce.service.js`) |
| Cash flow accounts | `SystemAccounts.CASH` / `.BANK` codes, imported |
| Sales due date | Derived from `parties.creditAgeingDays` — the configured credit term, not a hardcoded 30 days |

### 9.5 Date and time handling

Business date columns are `DATEONLY`, so `dateFrom <= col <= dateTo` is exactly
inclusive of both ends and has no timezone component to get wrong.

Audit-style timestamp columns (`stock_ledger_entries.createdAt`) are different:
`<= '2026-08-14'` would silently mean "up to 2026-08-14 00:00:00" and drop the
whole working day. `SqlWhere.dateRange(col, from, to, { timestamp: true })`
makes the upper bound an **exclusive next-midnight** instead — which is the
precise bug §24 of the brief warns about.

On the client, `YYYY-MM-DD` is split directly rather than parsed with
`new Date()`, which would shift the day backwards for any reader west of UTC.

---

## 10. UI/UX

Visual hierarchy, top to bottom: **Title → Category tabs → Report chips →
Report name + description → Toolbar → Notes → Summary → Table → Pagination.**

- **Desktop-first, responsive.** Filters reflow 1→2→4→5 columns; the table
  scrolls inside its own container so the page never scrolls sideways.
- **Sticky table header** with `max-h` so it stays useful on a long report.
- **Restrained.** Thin bordered summary tiles, no icons or gradients — a row of
  six sits directly above a dense table and must not compete with it.
- **Typed cells.** Numbers `tabular-nums` and right-aligned; codes medium
  weight; long text truncated with a `title`.
- **Loading** is a skeleton shaped like the table it replaces (same column
  count, same row height) so the layout does not jump.
- **Empty** distinguishes "no data at all" from "your filters excluded
  everything", and offers Reset only in the second case.
- **Error** shows the server's message; 403 does not offer a pointless Retry.
- **Export** shows "Preparing Excel…" inline and disables the other formats.

### 10.1 Accessibility

- Sortable headers are real `<button>`s with `aria-sort` on the `<th>`
- `scope="col"` on every header; `<dl>`/`<dt>`/`<dd>` for summary tiles
- Pagination is a `<nav aria-label>`; the count line is `role="status"`
- Skeletons carry `aria-busy` + a screen-reader-only label
- Errors are `role="alert"`
- Visible focus rings on every interactive element (`focus-visible:ring-2`)
- **Colour is never the only signal**: status badges always carry their label as
  text, and trend indicators use ▲/▼ as well as colour

### 10.2 Navigation

Reports went from 9 sidebar entries (2 dead, 5 aliases of one page) to **14
category leaves + the saved-report builder**, each gated by the same grant the
API checks — so a leaf never opens onto a 403. Six previously-dead `soon: true`
placeholders elsewhere in the sidebar (Day Book, Cash Flow, Receivables,
Payables, Stock Adjustment, Wage) now point at the reports that implement them.

---

## 11. Testing strategy

`tests/reports-module.test.js` targets the properties a report engine gets wrong
*silently*:

| Property | Test |
| --- | --- |
| Summary totals the whole set, not the page | `limit=1` summary equals the sum of all rows from `limit=100`, and exceeds the single visible row |
| Pagination neither repeats nor drops | Page 1 + page 2 of `limit=2` yield 4 distinct ids |
| Sorting is allow-listed | `sortBy=passwordHash` falls back to the report's default sort |
| Sorting cannot reach a denied column | A user without `VIEW_RATES` sorting by `netPaise` gets rows with no `netPaise` |
| Search is injection-safe | `' OR 1=1 --`, `%`, `_%_`, `a\b` all return 0 rows, HTTP 200 |
| Organisation isolation | Two seeded tenants; neither sees the other's rows, across four different reports |
| Location isolation | Manager assigned to Factory A sees 3 of 4 invoices; explicit Factory B → 403; summary scoped identically to rows |
| Field-level security | Money columns absent from `columns`, from every row object, and from `summary` |
| Export ≠ visible page | CSV with `limit=1` contains all 4 data rows |
| Export respects filters / scope / permission | Filter reflected in file and header; Factory B refused; read-without-export refused |
| Export respects `VIEW_RATES` | Clerk granted export but not rates gets a file with no money columns |
| Date inclusivity | `dateFrom = dateTo = 2026-08-05` includes the 05-Aug invoice |
| Cross-report consistency | Current Stock matches `/inventory/lots`; Receivables matches Sales Summary outstanding; due date matches the customer's configured credit period |
| Every report runs | All 46 execute, paginate and return a coherent envelope |
| Every report exports | All 46 × 3 formats produce a valid file (PDF starts `%PDF-`, XLSX starts `PK`) |

Backed by a **standalone smoke harness** run during development that executed
every report against the real database across every declared filter
individually, all filters combined, every sortable column, both permission
modes, factory-scope denial, and all three export formats.

---

## 12. Files changed

### New — backend (21 files, ~5,600 lines)

```
src/api/reports/lib/{registry,sqlWhere,columns,fragments,filters,runner}.js
src/api/reports/definitions/{sales,orders,purchase,production,inventory,
                             ageing,parties,labour,finance,analytics,index}.js
src/api/reports/export/{format,xlsx,pdf,index}.js
src/migrations/20260826000000-reporting-indexes.js
src/migrations/20260827000000-fix-stock-ledger-updatedat.js   (pre-existing bug, see §15.5)
tests/reports-module.test.js
```

### Modified — backend (5 files)

```
src/api/reports/reports.controller.js   + catalog/meta/data/export; saved-report API kept intact
src/api/reports/reports.router.js       + 3 catalog routes, ordered before /:id
src/api/reports/reports.schema.js       + strict report query/export/params schemas
src/utils/permissionCatalog.js          + REPORT_CATEGORIES and 22 codes
src/config/env.js  .env.example         + REPORT_EXPORT_MAX_ROWS
package.json                            + exceljs ^4.4.0
```

### New — frontend (10 files, ~1,500 lines)

```
src/components/reports/{report-nav,report-toolbar,report-filters,
                        report-table,report-summary,report-pagination,report-states}.jsx
src/hooks/use-report-catalog.js
src/lib/report-format.js
src/pages/SavedReportsPage.jsx          (preserves the M40 builder + document search)
```

### Modified — frontend (5 files)

```
src/pages/ReportsPage.jsx        rewritten as the catalog UI
src/App.jsx                      + 3 nested report routes
src/constants/navigation.js      Reports group rebuilt; 6 dead placeholders wired up
src/constants/enums.js           + 22 permission constants
src/lib/nav-match.js             + ownsPath / isNavHrefActive for nested routes
src/components/layout/sidebar.jsx  uses the nested-aware matcher
```

### Untouched

No business module, service or model outside the reports module was modified.
`utils/exporter.js`, `DataTable`, `usePaginated` and every other module's pages
are unchanged. The one change outside the module is the migration in §15.5,
which fixes a schema defect that made every stock movement fail.

---

## 13. Bugs found and fixed during implementation

Three real defects were caught by executing every report against the live
database rather than by inspection:

1. **Bind-parameter misalignment.** Two reports put a `$n` in the select list;
   the count query drops the select list, so Postgres received more parameters
   than the statement referenced. Both restructured to `LATERAL` joins, and the
   rule documented in `runner.js`.
2. **UNION across two enum types.** `receipts.status` and `payments.status` are
   structurally identical but *distinct* Postgres enums; a UNION will not
   implicitly convert between them. Both sides now cast to `text`.
3. **Enum filter caused a 500.** `enum_col = $1` makes Postgres cast the
   parameter to the enum type, so an out-of-vocabulary value raised
   `invalid input value for enum …` — a server error for what is really "the
   client asked for a status that doesn't exist". `SqlWhere.token()` compares as
   text, turning it into an empty result.

---

## 14. Remaining limitations

### 14.1 Missing data — reported, not fabricated

These are surfaced in the UI (`ReportLimitations`) and in each report's
`limitations` array, so a reader is told the system does not record something
rather than assuming it was zero.

| Gap | Consequence | What it would take |
| --- | --- | --- |
| **Sales Reference** — `parties` has a `SALES_REF` type but no sales document carries a `salesRefPartyId` | Brief 5.6 (Sales Reference Report) **not implemented**; the column and filter are absent from all sales/collection reports | Add `salesRefPartyId` to `sales_orders` / `sales_invoices` + migration + capture in the order form |
| **Discount** — no discount field on any sales or purchase document or line | Discount columns absent from Sales Summary, Sales Detail, Sales by Customer/Product/Location, Purchase reports | Add discount fields to line models and the tax-determination path |
| **Purchase tax breakdown** — `purchase_invoices` holds a single `amountPaise` | No gross/tax/net split on any purchase report | Add taxable-value and tax columns to `purchase_invoices` |
| **Physical stock count** — no entity exists | Stock Reconciliation reconciles the system against itself (lot balances vs ledger); Physical Quantity, Reconciliation Date and Approved By are absent | Add a stock-count document with lines, variance and approval |
| **Stock adjustment document** — adjustments are bare ledger entries | No Adjustment No, Previous Quantity or New Quantity | Add an adjustment document that writes the ledger entry |
| **Produced quantity per sales order** — production links to a plan line, not an order line | Sales Order Report shows `productionRequired` (real) instead of produced | Link production entries to the order they fulfil |
| **`createdBy` on transfers, receipts, payments, expenses** | "Created By" absent from those reports (the audit log has it per document) | Add `createdBy`, or join the audit log |
| **Ledger business date** — `stock_ledger_entries` has only `createdAt` | Stock movement is dated by when it was recorded; a backdated document appears on its entry day | Add a `businessDate` column written from the source document |
| **Payment mode on journal entries** | Day Book has no Payment Mode column | Carry the mode onto the journal, or join back to the source document |

### 14.2 Deferred by design

| Item | Status | Reasoning |
| --- | --- | --- |
| **Asynchronous export jobs** | Not implemented; documented | No durable queue exists (`jobs/scheduler.js` is an in-process timer that dies with the process). Implemented instead: inline export to 50,000 rows with a pre-flight count and an actionable refusal above it. The real fix is a job table + a worker + a download endpoint, which is infrastructure work beyond this module. |
| **Saved report filters (§14)** | Not implemented for the new module | `saved_reports` stores `{ name, reportType, params }` against an 11-value enum, not against catalog report ids. Extending it cleanly means a new table keyed by report id + the filter object. The URL already makes any filtered report shareable, which covers most of the need. |
| **Column resizing** | Not implemented | Column *visibility* is implemented and URL-persisted. Resizing needs drag state the current table does not carry. |
| **Excel logo embedding** | Not implemented | No logo asset is stored against an organisation in this schema. The organisation *name* is on every export. |
| **`.explain()` analysis** | Indexes added by reasoning about the access pattern; no `EXPLAIN` captured | The test database holds a handful of rows, so a plan from it would be meaningless. The indexes match the `(tenantId, factoryId, date)` shape every report filters on. |

### 14.3 Operational note

The new permission codes are **not granted to any existing role**. After
deploying, an administrator must grant `REPORT_<CATEGORY>_READ` (and
`_EXPORT` where wanted) through Roles & Permissions. `PLATFORM_ADMIN` and
`TENANT_OWNER` bypass permission checks and see everything immediately. The
seed script was intentionally not modified — silently widening existing roles'
access to financial reports is not a migration's decision to make.

---

## 15. Verification results

### 15.1 Reporting module test suite

```
tests/reports-module.test.js
Tests:       44 passed, 44 total
Time:        7.3 s
```

| Group | Tests | Result |
| --- | --: | --- |
| Report catalog (auth, per-category visibility, 404, 403) | 4 | pass |
| Report data contract (envelope, strict params, date range) | 4 | pass |
| Summary totals (whole set, follows filters, matches detail) | 3 | pass |
| Pagination (no repeats/drops, past-the-end) | 2 | pass |
| Sorting (both directions, allow-list, denied column) | 3 | pass |
| Search (declared fields, wildcards literal, injection-safe) | 3 | pass |
| Organisation isolation (two tenants, four reports) | 2 | pass |
| Location isolation (scoped rows, 403, in-scope, summary scoped) | 4 | pass |
| Field-level security (columns, values, tiles, positive case) | 4 | pass |
| Export (formats, full set, filters, scope, grant, VIEW_RATES, bad format) | 7 | pass |
| Report metadata | 2 | pass |
| **Every registered report runs** (46 reports) | 1 | pass |
| **Every registered report exports** (46 × 3 = 138 files) | 1 | pass |
| Cross-report consistency (stock, receivables, due date) | 3 | pass |

Notable assertions that hold against real data:

- Summary on a `limit=1` page equals the sum of all rows on `limit=100`, and exceeds the single visible row.
- Page 1 + page 2 of `limit=2` yield 4 **distinct** ids.
- `sortBy=passwordHash` falls back to the report's own default sort (`invoiceDate desc`).
- `search=%` returns **0** rows — a bare wildcard is matched literally, not as a pattern.
- Tenant A sees 4 invoices totalling 42 units; tenant B sees 1. Neither appears in the other, across four different reports.
- A manager assigned to Factory A sees 3 of 4 invoices; `?factoryId=<B>` returns **403**; their summary equals the sum of their own rows.
- A clerk without `VIEW_RATES` receives no money columns, no money keys on any row, and no money tiles — while still receiving `invoiceNumber` and `quantity`.
- CSV export with `limit=1` contains **4** data rows.
- A clerk granted export but not `VIEW_RATES` gets a file with no `Net Amount` / `Outstanding` columns and an explanatory line.
- Current Stock closing quantity equals the sum of AVAILABLE lots from `/inventory/lots`.
- Receivables outstanding equals the sum of Sales Summary outstanding.
- A customer configured with 15 credit days on a 20-Aug invoice gets due date **04-Sep-2026**.

### 15.2 Standalone execution harness

Before the suite existed, every report was executed directly against the test
database:

```
1044 / 1044 checks passed
```

Covering, for each of the 46 reports: every declared filter individually, all
filters combined, every sortable column, both permission modes (money-column
stripping asserted), factory-scope denial and empty-result behaviour, and all
three export formats.

### 15.3 Full backend suite

```
Test Suites: 21 passed, 2 failed, 23 total
Tests:      241 passed, 2 failed, 243 total
Time:       28.8 s
```

The two failures are **not caused by this work** and are **not in the reporting
module**:

| File | Assertion | Cause |
| --- | --- | --- |
| `tests/inventory.test.js:125` | `expect(lot.status).toBe('CURING')` | Fixture uses `receiptDate: '2026-08-10'` with `curingDays: 3`. Curing completed 13-Aug; today is 14-Aug, so `AVAILABLE` is the correct behaviour. |
| `tests/sales-production.test.js:182` | `expect(res.body.data.lot.status).toBe('CURING')` | Same: `productionDate: '2026-08-11'`, `curingDays: 3`, comment says "just produced today". |

Both are time-bomb fixtures written when the hardcoded date was in the future.
The fix is to make those dates relative to the current date; they were left
alone because they belong to other modules' test suites and changing their
semantics is not this task's call.

### 15.4 Frontend

```
npm run build   ✓ 1889 modules transformed, built in 2.4 s
npx eslint      ✓ 0 problems (0 errors, 0 warnings)
```

The backend has no ESLint configuration (`npm run lint` fails with
"couldn't find an eslint.config.js"), which is pre-existing.

### 15.5 Pre-existing bugs found and fixed

Building this surfaced two defects outside the reporting module. Both are real,
and the first is severe.

**1. Every stock movement failed against the production schema.** *(fixed)*

`stock_ledger_entries.updatedAt` is `allowNull: false` in the migration, but the
model declares the ledger append-only (`updatedAt: false`), so Sequelize never
supplies a value:

```
null value in column "updatedAt" of relation "stock_ledger_entries"
violates not-null constraint
```

Every goods receipt, production entry, dispatch and stock transfer returned
**500** against a migration-built schema — which is what production runs, and
what `tests/helpers/db.js` switched the test suite to. Fixed by
`20260827000000-fix-stock-ledger-updatedat.js`, which makes the column nullable
(matching the model, and matching how `journal_entries` / `journal_lines` were
correctly defined with `createdAt` only). Reversible, with a backfill in `down`.

This is exactly the model-vs-migration drift `tests/helpers/db.js` warns about
in its own header comment.

**2. A tenant's second factory cannot create its first document.** *(reported, not fixed)*

`DocumentNumberingService` formats numbers as `<prefix>/<sequence>` with **no
factory component**, while the series itself is keyed per
`(documentType, factoryId, financialYearId)`. Factory A and Factory B therefore
both generate `GRN/0001`, and the tenant-wide unique index on the document
number rejects the second with a 409.

Not fixed here: the correct fix changes what document numbers look like, which
is a business decision (include the factory code in the prefix, or make the
unique index per-factory). The reporting test fixture works around it the way an
administrator would — by configuring a distinct `document_series.prefix` per
factory, which is what that column exists for.

---

## 16. Summary

| Category | Reports | Implemented | Export XLSX | Export PDF | Export CSV |
| --- | --: | --: | --: | --: | --: |
| Sales | 5 | 5 | 5 | 5 | 5 |
| Orders | 2 | 2 | 2 | 2 | 2 |
| Purchase | 4 | 4 | 4 | 4 | 4 |
| Production | 3 | 3 | 3 | 3 | 3 |
| Inventory | 5 | 5 | 5 | 5 | 5 |
| Stock Ageing | 3 | 3 | 3 | 3 | 3 |
| Customer | 3 | 3 | 3 | 3 | 3 |
| Vendor | 3 | 3 | 3 | 3 | 3 |
| Contractor | 3 | 3 | 3 | 3 | 3 |
| Labour | 3 | 3 | 3 | 3 | 3 |
| Payments | 3 | 3 | 3 | 3 | 3 |
| Expenses | 2 | 2 | 2 | 2 | 2 |
| Finance | 4 | 4 | 4 | 4 | 4 |
| Analytics | 3 | 3 | 3 | 3 | 3 |
| **Total** | **46** | **46** | **46** | **46** | **46** |

Not implemented: **1** — Sales Reference Report (§14.1), because the schema
records no sales-reference attribution on any sales document.
