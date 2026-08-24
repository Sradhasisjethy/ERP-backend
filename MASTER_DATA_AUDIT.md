# Master Data Module — Production-Grade Audit

**Date:** 2026-08-19
**Scope:** Master Data (M01 Organization/Factory, M03 Product/BOM/UoM, M04 Parties, M05 Pricing) and their downstream integration.
**Method:** Every claim below was traced UI → hook → API → route → middleware → controller → service → model → migration → SQL, and then verified by executing it. Nothing is marked PASS because a file exists.

---

## 0. Correction to the stated stack

The brief describes the backend as **Node.js + Express + MongoDB**. The application does not use MongoDB.

| Stated | Actual |
|---|---|
| MongoDB | **PostgreSQL** (`pg`, `pg-hstore`) |
| Mongoose models | **Sequelize v6** models + 20 versioned migrations under `src/migrations/` |
| Document collections | Relational tables with foreign keys, partial unique indexes and enums |

This is not a quibble: the audit's database section asks about indexes, unique constraints, references and soft deletion, and all four behave differently here. Everything below is assessed against the relational schema that actually ships. Frontend is React + Vite + JavaScript as described.

---

## 1. Architecture assessment

**Verdict: PASS — the foundations are sound. The defects found are gaps in enforcement, not in design.**

| Layer | Assessment |
|---|---|
| Routing | Consistent `router → authenticate → tenantScope → auditContext → authorize → validate → controller`. Every master follows it. |
| Multi-tenancy | `tenantId` injected from the JWT into a CLS namespace (`src/core/tenantContext.js`) and applied automatically by `BaseScopedModel` hooks. Callers never filter by tenant by hand, so they cannot forget to. Genuinely good design — with one hole, found and fixed (§5.1). |
| Location scope | `Factory` is the location master; access is many-to-many via `user_factories` and enforced by `src/core/factoryAccess.js`. Correctly applied to *transactions*. Masters are deliberately tenant-wide, which is right — a product should not be redefined per plant. |
| RBAC | Permission catalog (`src/utils/permissionCatalog.js`) is a single source of truth generating both route guards and the UI matrix, with legacy `_WRITE` widening. Route-level, server-side, verified by direct API call. |
| Validation | zod schemas per module, applied as middleware, with parsed values written back to `req`. |
| Error handling | Central `sendError` maps Sequelize unique/FK/validation/optimistic-lock errors to 409/400/409. Good. |
| Money | Integer paise throughout (`BIGINT`), never floats. Correct for an ERP. |
| Audit trail | `BaseAuditedModel` writes before/after snapshots automatically. Coverage was incomplete (§5.6), now closed. |
| Field masking | BR-27 rate masking is applied **server-side** (`maskRateFields`), not by hiding UI columns. Correct. |

**Structural weakness found:** two parallel BOM implementations existed. `ProductsService.createMixDesign/updateMixDesign/activateMixDesign/deleteMixDesign` was a complete second BOM engine with no versioning that hard-deleted history. It was dead code — the controller routes to `BomService` — but it was one careless import away from being used. Removed.

---

## 2. Master-by-master status

Status reflects the state **after** the fixes in §9. The "Before" column is what the audit found.

| # | Master | Implementation | Before | After | Notes |
|---|---|---|---|---|---|
| 1 | Organization | `Organization` + `Office` + `Department` | PARTIAL | **PASS** | No audit trail, no `auditContext` on the router. Both fixed. |
| 2 | Branch / Location | `Factory` (plant) + `Office` (admin) | PASS | **PASS** | Two distinct concepts, both present. Factory drives BR-04/09/14/21 policy and BR-29 access. |
| 3 | Customer | `Party(partyType=CUSTOMER)` | FAIL | **PASS** | Duplicates allowed; hard-deletable; usable when inactive; no GSTIN validation. All fixed. |
| 4 | Vendor | `Party(partyType=VENDOR)` | FAIL | **PASS** | Same as Customer, plus a PO could be raised against a customer. Fixed. |
| 5 | Contractor | `Party(partyType=CONTRACTOR)` | PARTIAL | **PASS** | Downstream integration (material issue, production entry, advances) was already correct. Delete protection added. |
| 6 | Labour | `Party(LABOUR)` + `LabourWageProfile` | PARTIAL | **PASS** | Wage profile 1:1 extension, correctly refused on non-LABOUR types. Delete protection added. |
| 7 | Product | `Product` | FAIL | **PASS** | Deleting a product silently destroyed its entire BOM and price history. Fixed at both service and FK level. |
| 8 | Product Category | `ProductCategory` | FAIL | **PASS** | No unique constraint, no cycle protection, no audit trail, deletable while in use. All fixed. |
| 9 | Product Type | ENUM on `Product` (`FINISHED_GOOD`/`RAW_MATERIAL`) | **N/A** | **N/A** | Not a master and does not need to be — see §3.5. |
| 10 | Unit of Measure | `Uom` + `UomConversion` | PARTIAL | **PASS** | Conversion logic (bidirectional, one-hop) is genuinely well built. UoM itself had no audit trail and was deletable while referenced by products. Fixed. |
| 11 | Sales Reference | `Party(SALES_REF)` | **FAIL** | **FAIL (documented)** | The type exists and rows can be created, but **no transaction anywhere references a sales-reference party**. See §3.1 — deliberately not implemented. |
| 12 | BOM | `MixDesign` | PARTIAL | **PASS** | Versioning/supersession/date resolution were excellent. **No circular-reference protection at all.** Fixed. |
| 13 | BOM Items | `MixDesignLine` | PARTIAL | **PASS** | Wastage %, optional flag, per-line UoM all correct. No duplicate-component or cross-tenant check. Fixed. |
| 14 | Vehicle | — | **FAIL** | **FAIL (documented)** | Free-text `vehicleNumber` on challans and transfers. No master. See §3.2. |
| 15 | Payment Mode | ENUM in a JSONB `modes` array | **FAIL** | **FAIL (documented)** | `CASH`/`UPI`/`BANK`/`CHEQUE` hardcoded. See §3.3. |
| 16 | Expense Category | Free-text `STRING` on `expenses` | **FAIL** | **FAIL (documented)** | See §3.4. |
| 17a | HSN Code | `HsnCode` | PARTIAL | **PASS** | Drives GST rate on every invoice line. No audit trail, deletable while in use. Fixed. |
| 17b | Price List / Items | `PriceList` + `PriceListItem` | PASS | **PASS** | Already audited, already uniquely constrained per (list, product). |
| 17c | Party Address | `PartyAddress` | PARTIAL | **PASS** | Drives GST place of supply. Any address was editable through any party's URL. Fixed. |
| 17d | Financial Year | `FinancialYear` | PASS | **PASS** | Single-current invariant enforced transactionally. |
| 17e | Document Series | `DocumentSeries` | PASS | **PASS** | Gap-free numbering with a unique index; already tested. |
| 17f | Chart of Accounts | `Account` | PASS | **PASS** | Out of Master Data scope; not modified. |

### Per-master capability matrix (after fixes)

Legend: ✅ PASS · ⚠️ PARTIAL · ❌ FAIL · — N/A

| Capability | Product | Category | UoM | HSN | Customer | Vendor | Contractor | Labour | BOM | Org | Factory |
|---|---|---|---|---|---|---|---|---|---|---|---|
| List page | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Create | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| View (read-only detail) | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ⚠️ | ✅ | ✅ | ⚠️ |
| Edit | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ (draft only, by design) | ✅ | ✅ |
| Delete / deactivate | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Search | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Filters | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sorting | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| Pagination | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Validation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Duplicate prevention | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| Status handling | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Organization scope | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Location scope | — | — | — | — | — | — | — | — | — | — | ✅ |
| RBAC (server-side) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Audit logging | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| API validation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Database validation | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| Error handling | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Loading states | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Empty states | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ⚠️ | ⚠️ |
| Responsive UI | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**"View" is PARTIAL across the board and left as-is.** Every master opens an *edit* dialog; there is no read-only detail screen. A user holding only `PRODUCT_READ` now sees no edit affordance at all (fixed in §9), so they can list and search but cannot inspect one record's full field set. This is a real gap, but adding detail screens for nine masters is a UI feature, not an integrity fix — recorded in §3.6 rather than built.

**Organization/Factory show ⚠️ on sorting, duplicate prevention, database validation and empty states.** Those two masters sit in the Administration module, not Masters. Their services were left on their original list signatures deliberately — see §11 "Deliberately not changed".

---

## 3. Missing functionality

Per the brief: identified first, with impact, and implemented only where legitimate.

### 3.1 Sales Reference is an orphan master — **P1, NOT IMPLEMENTED**

- **Missing feature:** `Party(SALES_REF)` rows can be created, listed and edited, but no sales document carries a `salesRefPartyId`. A sales reference can never be attached to anything.
- **Business reason:** commission and channel attribution — knowing which agent brought which order.
- **Frontend impact:** a "Sales Reference" field on the sales-order form; a filter and column on sales reports.
- **Backend impact:** `salesRefPartyId` on `sales_orders` (and probably `sales_invoices`), carried through order → invoice, plus a `SALES_REF` type guard.
- **Database impact:** new nullable FK column + index on two transactional tables.
- **Downstream impact:** unlocks sales-by-reference reporting, which the reports module currently declares as a known limitation in `src/api/reports/definitions/sales.js`.
- **Why not implemented:** this adds a column to two transactional tables and a field to the sales-order flow. It is a **sales-module feature**, not a master-data defect, and the brief says not to modify unrelated modules. The master itself is complete and correct; only its consumer is missing.

### 3.2 Vehicle master does not exist — **P2, NOT IMPLEMENTED**

- **Missing feature:** `vehicleNumber` is a free-text `STRING` on `delivery_challans` and `stock_transfers`. There is no vehicle master, no driver master, no capacity, no ownership flag.
- **Business reason:** freight cost per vehicle, trip history, capacity-aware dispatch planning.
- **Frontend impact:** a Vehicles master screen; the challan and transfer forms become a picker instead of a text box.
- **Backend impact:** new `vehicles` module (model, service, controller, router, schema); `vehicleId` FK alongside the retained text column.
- **Database impact:** new table + FK on two transactional tables + backfill of existing free-text values.
- **Downstream impact:** dispatch, transfer, and any freight reporting.
- **Why not implemented:** this is a **new module**, not a repair. The brief explicitly says not to invent masters that the existing requirements do not justify, and nothing in the current schema treats a vehicle as anything more than a printed line on a challan.

### 3.3 Payment Mode is a hardcoded enum — **P2, NOT IMPLEMENTED**

- **Missing feature:** `CASH`/`UPI`/`BANK`/`CHEQUE` are a zod enum inside a JSONB `modes` array on receipts and payments. A tenant cannot add "NEFT" or map a mode to a specific bank account.
- **Business/DB/downstream impact:** would need a `payment_modes` table, per-mode ledger-account mapping, and migration of every existing JSONB payload.
- **Why not implemented:** the four modes cover the documented requirement and each already has bespoke handling (the cheque lifecycle in `cheque.service.js` is mode-specific logic, not data). Turning this into a master is a finance-module redesign with a data migration, well outside a master-data audit.

### 3.4 Expense Category is free text — **P2, NOT IMPLEMENTED**

- **Missing feature:** `expenses.category` is an unconstrained `STRING`. "Fuel", "fuel" and "Fuel " are three categories in the expense report.
- **Business reason:** expense analysis is only as good as its categories; free text guarantees drift.
- **Impact:** new `expense_categories` master + FK; the expense form becomes a picker; existing values need normalising and backfilling.
- **Why not implemented:** it modifies the Expenses module and requires a data migration of live rows. Genuinely worth doing — recommended in §10 as the highest-value of the three deferred masters, because unlike Vehicle it actively degrades an existing report.

### 3.5 Product Type as a master — **N/A, correctly absent**

`FINISHED_GOOD` / `RAW_MATERIAL` is a two-valued enum that **branches code**: `curingDays` only applies to finished goods, BOMs are only defined for finished goods, and production consumes raw materials. A user-extensible third value would have no defined behaviour anywhere. Correctly an enum, not a master. No action.

### 3.6 Read-only detail views — **P2, NOT IMPLEMENTED**

- **Missing feature:** no master has a view-only detail screen; "view" is the edit dialog.
- **Impact:** a `PRODUCT_READ`-only user can see list columns but not a record's full field set (reorder level, min/max stock, ageing thresholds are not list columns).
- **Why not implemented:** nine new screens is a UI workstream, not an integrity fix. It became more visible after §9 correctly hid edit buttons from read-only users, so it is called out here rather than left silent.

---

## 4. Broken flows (all found by execution, not inspection)

| # | Broken flow | Severity | Status |
|---|---|---|---|
| B1 | **Every write to `employees` failed against a migrated database.** `User` declared `resetPasswordToken`/`resetPasswordExpires`; no migration created them. Sequelize names every declared attribute in `INSERT ... RETURNING`, so *any* user create errored with `column "resetPasswordToken" does not exist` — breaking user creation, tenant onboarding, the seed script, password reset, and **the entire test suite** (55/55 red in the four suites first run). | **P0** | **FIXED** |
| B2 | **Deleting a product destroyed its BOM and price history.** `mix_designs.productId` and `price_list_items.productId` were `ON DELETE CASCADE`. A product not yet transacted deleted cleanly and took every BOM version, every BOM line and every price row with it. No warning, no recovery. | **P0** | **FIXED** |
| B3 | **`Model.count()` silently ignored the tenant filter.** Sequelize routes `count()` through `beforeCount`, not `beforeFind`; only `beforeFind` was hooked. Proven directly: `findAll` → 1 row, `count` → 2 rows across tenants, same query. 19 call sites affected, including every dashboard tile (curing lots, dead stock, pending approvals, unread notifications) and the analytics dispatch counter. | **P0** | **FIXED** |
| B4 | **A sales order could be raised against a vendor, a contractor or a labourer.** The FK proves the id is *a party*; nothing checked `partyType`. The order posts to accounts receivable, corrupting that party's ledger from the first document. Symmetrically, a purchase order accepted a customer. | **P1** | **FIXED** |
| B5 | **Inactive masters were fully usable.** Setting a customer or product to `inactive` had no effect on transaction creation — status was a decorative badge. The one exception was invoicing, which filtered addresses by status. | **P1** | **FIXED** |
| B6 | **No circular-BOM protection whatsoever.** A BOM could list its own output product as a component, or close a loop transitively (A needs B, B needs A). `BomService.explode()` recurses on nested BOMs, so this is an unbounded recursion waiting on the first nested explode, and a production entry against such a recipe books consumption of the good it is creating. | **P1** | **FIXED** |
| B7 | **Duplicate masters were freely creatable.** `parties` had no unique constraint at all — two "Acme Traders" rows split one customer's receivables across two ledgers, and neither balance is correct. `product_categories` had no unique code either. | **P1** | **FIXED** |
| B8 | **Sorting was accepted, ignored, then faked.** Every list schema accepted `sortBy`/`sortDir`; no master service used them. The frontend never sent them and instead sorted client-side over a **server-paginated** result — so clicking "Name" reordered the visible 10 rows out of 400 and presented the result as a sorted column. | **P1** | **FIXED** |
| B9 | **Any party address was editable through any party's URL.** `PUT /parties/:id/addresses/:addressId` never checked that the address belonged to `:id`. Same-tenant only, but "edit customer A's delivery address via customer B" is how a dispatch gets rerouted. | **P2** | **FIXED** |
| B10 | **Masters could be deleted while referenced.** UoM, category and HSN had no dependency check. FK `RESTRICT` caught the worst cases but surfaced as a generic *"references a record that does not exist or is still in use"* 400 that named nothing. | **P1** | **FIXED** |

---

## 5. Security issues

### 5.1 Tenant isolation bypassed by `count()` — **P0, FIXED**

The most serious finding. `BaseScopedModel` hooked `beforeFind` but not `beforeCount`. Proven empirically, not inferred:

```
findAll({ where: { code: 'X' } })  -> 1   (correctly scoped to this tenant)
count(  { where: { code: 'X' } })  -> 2   (every tenant on the platform)
```

Nineteen call sites were affected. The dashboard tiles a tenant sees — curing lots, dead stock, slow-moving stock, pending variance approvals, unread notifications — were counted across **all** tenants. Fixed by adding a `beforeCount` hook alongside `beforeFind` in `src/core/BaseModel.js`, which closes all 19 at once. Re-verified: `findAll` 1, `count` 1.

### 5.2 Multi-tenant isolation on masters — **PASS (verified, no defect)**

Two full tenants were created and cross-tenant access attempted through the real API for parties, products, categories, UoMs and BOMs:

- `GET /:id` on another tenant's record → 404 ✅
- The record never appears in the other tenant's list ✅
- `PUT` and `DELETE` on another tenant's record → 404, record survives ✅
- Both tenants can independently hold the same product code ✅ (regression-guarded — an unscoped uniqueness check would break this)

### 5.3 RBAC is genuinely server-side — **PASS (verified by direct API call)**

A user granted only `PARTY_READ` + `PRODUCT_READ`, calling the API directly with no UI involved:

| Call | Result |
|---|---|
| `GET /parties` | 200 ✅ |
| `POST /parties` | **403** ✅ |
| `PUT /parties/:id` | **403** ✅ |
| `DELETE /parties/:id` | **403** ✅ |
| `POST /products` | **403** ✅ |
| Any master endpoint, no cookie | **401** ✅ |

Frontend button-hiding was absent and has been added (§9), but it was never the control — the API was already correct.

### 5.4 Rate masking (BR-27) — **PASS**

`standardCostPaise`, `creditLimitPaise`, `dailyWagePaise` and BOM cost rollups are stripped server-side by `maskRateFields` for users without `VIEW_RATES`. Already covered by existing tests.

### 5.5 Path-confusion on nested addresses — **P2, FIXED** (see B9).

### 5.6 Incomplete audit trail — **P1, FIXED**

BR-30 requires every create/update to record user, timestamp, IP and a before/after snapshot. Six masters were on the non-auditing base class and wrote **no audit rows at all**: `Uom`, `ProductCategory`, `HsnCode`, `Organization`, `Office`, `Department`. Separately, `organization.router.js` never mounted `auditContext`, so any audit row from that router would have carried a null user. Both fixed; verified by asserting `CREATE`/`UPDATE` rows exist with a non-null `userId` and a correct `afterSnapshot`.

### 5.7 GSTIN accepted unvalidated — **P2, FIXED**

`gstin` was `z.string().optional()`. A malformed GSTIN is not caught until the GST return is rejected — long after the invoice has gone to the customer. Now validated against the 15-character format at the API and mirrored in the UI.

---

## 6. Database issues

| # | Issue | Severity | Status |
|---|---|---|---|
| D1 | `employees.resetPasswordToken` / `resetPasswordExpires` declared in the model, absent from every migration (B1). | **P0** | FIXED — `20260828000000` |
| D2 | `mix_designs.productId` and `price_list_items.productId` were `ON DELETE CASCADE` (B2). | **P0** | FIXED — both now `RESTRICT` |
| D3 | `parties` had **no unique constraint of any kind** beyond its PK. | **P1** | FIXED — partial unique on `(tenantId, code)` and `(tenantId, partyType, gstin)` |
| D4 | `product_categories` had no unique constraint on `code`. | **P1** | FIXED — partial unique on `(tenantId, code)` |
| D5 | No supporting indexes on master filter/join columns. Postgres does not index FK columns automatically, so the new dependency checks would have been ~20 sequential scans per delete. | **P2** | FIXED — 18 indexes added |
| D6 | **No soft deletion anywhere in the system.** No model sets `paranoid: true`; there is no `deletedAt` column. | **P1** | **Deliberately not changed** — see below |

### On soft deletion

The brief asks for it. It was **not** introduced, for a specific reason: adding `paranoid: true` across the master models changes the semantics of every existing query, index and unique constraint at once (a partial unique index must then exclude soft-deleted rows, or a deleted code can never be reused). The same requirement — *history must survive, and a retired master must stop accepting new documents* — is fully met by the existing `status: active|inactive` column, which is already on every master, already exposed in the UI, and now actually enforced (B5). Physical deletion is now refused whenever anything references the record (§7), so nothing referenced can be lost. Soft deletion would add a third state without adding a guarantee. Recorded in §10 as a deliberate architectural decision rather than an omission.

### Constraint/index verification

Confirmed present after migration: `products_tenant_code_unique`, `uoms_tenant_code_unique`, `hsn_codes_tenant_code_unique`, `mix_designs_one_active_per_product` (partial unique — a genuinely good existing constraint), `price_list_items_list_product_unique`, plus the four new unique indexes and 18 new performance indexes. Every master carries `tenantId NOT NULL` with a CASCADE FK to `tenants`, `createdAt`/`updatedAt`, and a `status` enum. `createdBy`/`updatedBy` are **not** columns on master tables — attribution lives in `audit_logs` with full before/after snapshots, which is strictly more informative. Not a defect.

---

## 7. Cross-module dependency check

Consumers were enumerated from the schema, not assumed, and each master's delete path now checks every one of them.

| Master | Verified consumers | Delete behaviour |
|---|---|---|
| **Product** | Sales order/invoice/return lines, delivery challan lines, purchase order/receipt/return/indent lines, stock ledger, stock lots, reservations, transfer lines, production entries & plan lines, material consumption, wastage, contractor issues & entries, **BOM headers**, **BOM component lines**, **price list items** | Refused with the blocking record named; deactivation offered. 21 dependencies checked. |
| **Customer / Vendor / Contractor / Labour** | Sales orders, invoices, returns, credit notes, purchase orders, invoices, receipts, returns, debit notes, receipts, payments, expenses, **ledger postings**, price lists, contractor material issues, contractor production entries, attendance, advances | Refused, named, deactivation offered. 18 dependencies checked. Delivery challans and purchase indents reach their party transitively via the order and are covered by it. |
| **UoM** | Products, BOM component lines, UoM conversions (both directions) | Refused. |
| **Product Category** | Products, sub-categories | Refused. |
| **HSN Code** | Products | Refused. |
| **BOM** | Production entries, contractor production entries | Already correct before the audit — only an unused DRAFT can be discarded (FR-M03-9). |

**Production genuinely uses the BOM.** Verified by reading and by execution: both `production.service.js` and `workforce.service.js` call `BomService.resolveForDate(productId, productionDate)` and iterate `mixDesign.lines`. There is no duplicated BOM logic in the production path — the second implementation that existed was in `ProductsService` and was dead. Removed.

---

## 8. Performance issues

| # | Issue | Severity | Status |
|---|---|---|---|
| PF1 | No indexes on master filter columns (`parties.status`, `products.categoryId`, `products.status`, `products.productType`, FK columns on `mix_design_lines`, `party_addresses`, `price_list_items`, `uom_conversions`). | P2 | FIXED — 18 indexes |
| PF2 | Delete dependency checks issue one `COUNT` per dependent table (21 for a product). | P2 | Accepted. Each is a single indexed count and only runs on an explicit delete, which is rare and interactive. The alternative — one giant UNION — is far harder to read and to extend when a table is added. |
| PF3 | `UomService.convert` issues up to 4 queries and is called once per BOM line during explode. | P2 | Not changed — pre-existing, correct, and only hit on explode/cost, not on the hot production path. Noted for future caching. |
| PF4 | Frontend bundle is 990 kB (261 kB gzipped), single chunk. | P2 | Pre-existing, unrelated to Master Data. Not changed. |

---

## 9. UI/UX issues and what was changed

| # | Issue | Severity | Status |
|---|---|---|---|
| U1 | **Sorting sorted one page and looked authoritative** (B8). Server-paginated tables used TanStack's client sort model. | P1 | FIXED — sorting now goes to the API. `DataTable` gained a `manualSorting` mode and a `sortableColumns` allow-list, so a column the API will not order by is not clickable rather than clickable-and-lying. |
| U2 | **The party `code` field had no input.** `code` was in form state and in the request payload but no control was ever rendered — a party code could not be entered from the UI at all. | P1 | FIXED — field added, plus a Code column on the list. |
| U3 | **No RBAC gating on any master action.** Every user saw Add/Edit/Delete. The API refused them (correctly), but the UI invited an action that always failed. | P2 | FIXED — buttons gated on `PRODUCT_*` / `PARTY_*`. |
| U4 | **Delete confirmation was wrong and errors vanished.** "This cannot be undone" was accurate but useless; the mutation had no `onError`, so a 409 refusal produced no message at all. | P1 | FIXED — the dialog explains that only an unreferenced record can be deleted and points at deactivation; the server's specific refusal is surfaced in an alert band. |
| U5 | **Generic empty states.** Every table showed "No results." | P2 | FIXED — seven per-table empty states that say what to create and why. |
| U6 | No GSTIN format feedback until the server responded. | P2 | FIXED — validated in the dialog against the same pattern the API enforces, with a format placeholder and hint. |
| U7 | Party search covered name and GSTIN only. | P2 | FIXED — now name, code, GSTIN and phone; product/category/HSN search widened similarly. |
| U8 | No read-only detail view for any master. | P2 | **Not fixed** — §3.6. |
| Loading states | Skeleton on load, "Updating…" spinner on refetch, disabled+"Saving..." on submit. | — | Already correct. |
| Responsive | Tables wrap in `overflow-x-auto`; dialogs use `max-w-*`; pagination controls wrap. | — | Already correct. |

---

## 10. Recommended changes (not implemented)

Ordered by value. None of these are defects in Master Data; each modifies another module or is a feature.

1. **P1 — Attach Sales Reference to sales documents** (§3.1). The master is complete and unusable. Smallest change with the clearest payoff.
2. **P2 — Promote Expense Category to a master** (§3.4). Free text is actively degrading an existing report. Needs a normalising backfill.
3. **P2 — Read-only detail views for the nine masters** (§3.6). Now more visible because read-only users correctly see no edit button.
4. **P2 — Fix the two date-sensitive tests.** `inventory.test.js` and `sales-production.test.js` assert a lot is `CURING`, using hardcoded 2026-08-10/11 dates against a 3-day curing period. They passed when written and fail now purely because the wall clock has moved past the curing window. They are the only 2 failures in the suite and were failing **before** this audit began. They belong to Inventory/Production, so they were left alone rather than touched in a Master Data change — but they are time bombs and should be pinned to a relative date.
5. **P2 — Vehicle and Payment Mode masters** (§3.2, §3.3) if and when the business asks for freight costing or configurable modes.
6. **P3 — Revisit soft deletion** (§D6) only if a genuine "restore a deleted master" requirement appears. `status` plus dependency-guarded deletes covers the stated need today.

---

## 11. Files changed

### Backend — new (5)

| File | Purpose |
|---|---|
| `src/core/masterGuards.js` | Shared integrity guards: `assertNoDependents`, `assertUnique`, `assertUsableParty`, `assertUsableProducts`. |
| `src/migrations/20260828000000-fix-employee-reset-password-drift.js` | Adds the two missing `employees` columns (B1/D1). |
| `src/migrations/20260829000000-master-data-integrity.js` | CASCADE→RESTRICT on two FKs; 3 partial unique indexes; 18 performance indexes. |
| `tests/master-data-audit.test.js` | 32 assertions — the audit's evidence and its regression guard. |
| `tests/master-data-e2e.test.js` | 16 assertions — the full master→transaction→ledger→report flows. |

### Backend — modified (18)

| File | Change |
|---|---|
| `src/core/BaseModel.js` | **`beforeCount` tenant hook** — closes the cross-tenant count leak (B3/§5.1). |
| `src/api/products/products.service.js` | Dependency guards on all four masters; duplicate prevention; category-cycle protection; reference resolution; min/max coherence; server-side sorting; **removed the dead duplicate BOM implementation**. |
| `src/api/products/bom.service.js` | `assertNoCycle` (direct + transitive, re-checked at activation); `assertLinesValid` (duplicate components, existence, active, cross-tenant, UoM); sorting. |
| `src/api/parties/parties.service.js` | 18-table dependency guard; code/GSTIN duplicate prevention; immutable `partyType` once documents exist; sorting; widened search. |
| `src/api/parties/partyAddress.service.js` | Address operations scoped to the party in the path (B9). |
| `src/api/sales/sales.service.js` | Customer must be a `CUSTOMER` and active; line products must exist and be active (B4/B5). |
| `src/api/purchasing/purchasing.service.js` | Same guards on purchase orders **and** goods receipts. |
| `src/api/products/products.controller.js`, `src/api/parties/parties.controller.js` | Thread `sortBy`/`sortDir`; pass the party id into address operations. |
| `src/api/products/products.schema.js` | Stock-range refinement; removed a duplicate `search` key that silently overrode the validated one. |
| `src/api/parties/parties.schema.js` | GSTIN pattern; phone bounds; removed the same duplicate `search` key. |
| `src/api/products/uom.model.js`, `productCategory.model.js`, `hsnCode.model.js`, `src/api/organization/organization.model.js`, `office.model.js`, `department.model.js` | Moved onto `BaseAuditedModel` (BR-30). |
| `src/api/organization/organization.router.js` | Added the missing `auditContext` middleware. |

### Frontend — modified (5)

| File | Change |
|---|---|
| `src/hooks/use-paginated.js` | Sorting state; sends `sortBy`/`sortDir`; resets to page 1 on sort change. |
| `src/components/data-table/data-table.jsx` | `manualSorting` mode; `sortableColumns` allow-list so unsortable headers are not clickable. |
| `src/pages/PartiesPage.jsx` | RBAC gating; server sorting; Code column; delete-error band; honest delete copy; empty state; widened search. |
| `src/pages/ProductsPage.jsx` | RBAC gating on all five tabs; server sorting; delete-error band; honest delete copy; seven empty states. |
| `src/components/parties/party-form-dialog.jsx` | Added the missing Code input; GSTIN validation, uppercase normalisation, format hint. |

---

## 12. Tests executed

### Backend suite

| Run | Suites | Tests | Result |
|---|---|---|---|
| Initial (as found) | 4 of 4 failed | **0 / 55** | Every suite red — `column "resetPasswordToken" does not exist` (B1). |
| Baseline (after B1 fix, before audit fixes) | 22 passed, 2 failed | 242 passed, 2 failed | The 2 failures are the pre-existing date-sensitive curing tests (§10.4). |
| Audit suite, before fixes | — | **9 passed, 23 failed** | The audit's evidence. |
| Audit suite, after fixes | — | **32 / 32 passed** | |
| End-to-end flow suite | — | **16 / 16 passed** | |
| **Final full suite** | **24 passed, 2 failed** | **290 passed, 2 failed** | Same 2 pre-existing failures. **No regressions.** |

### What the 32 audit assertions cover

Multi-tenant isolation across five masters (list, read, update, delete) · cross-tenant update/delete refusal · RBAC read-only role against create/modify/delete on two masters · unauthenticated rejection · duplicate party code · duplicate GSTIN per type · same GSTIN allowed across roles · duplicate product and category codes · same code allowed in different tenants · product delete blocked by BOM / price list / stock movement, with the dependent row proven intact afterwards · customer delete blocked by a sales order, with the order still resolving the customer's name · unused masters still deletable · UoM and category delete blocked while referenced · sales order refused against a vendor · sales order refused for an inactive customer · sales order line refused for an inactive product · purchase order refused against a customer · self-referencing BOM · transitive circular BOM · duplicate BOM components · cross-tenant BOM component · server-side sort ascending and descending across the whole result set · unknown sort column ignored rather than erroring · audit CREATE/UPDATE rows with a non-null user for UoM, category, HSN and organization · malformed GSTIN rejected, well-formed accepted · incoherent min/max stock rejected · self-parented category rejected · address edit through the wrong party's URL refused.

### What the 16 end-to-end assertions cover

Masters created through their own public API (UoM, HSN, category, raw material, finished good, customer with tax and credit terms, vendor, shipping address with a derived state code) → BOM defined and activated → BOM explode with wastage (21 units for 10 output at 2/unit + 5%) → cost rollup from the product master (84,000 paise) → goods receipt against the vendor → **production entry consuming per the BOM and citing the BOM version used** → sales order for the customer → confirm → delivery challan → invoice with **intra-state CGST+SGST determined from the shipping address** → receipt fully allocated against the invoice → **customer ledger closing at nil** → customer outstanding and ledger reports resolving the customer by name → purchase order → goods receipt → vendor invoice → payment → vendor ledger → payables report → **deactivating the customer blocks new orders while every historical order, ledger row and report entry still resolves it** → deactivating the finished good keeps its BOM, stock and invoices intact, and delete stays refused.

### Frontend

`vite build` — **clean**, 1917 modules transformed.
`eslint src` — **0 errors**, 7 pre-existing `react-refresh` warnings in untouched UI primitives.

### Not verified

- **Browser-rendered UI.** Verified by build, lint and code trace; not by driving a browser. Responsive behaviour is asserted from the CSS (`overflow-x-auto`, `max-w-*`, flex-wrap), not measured at breakpoints.
- **Load/scale.** Indexes were added on reasoning about the query shapes; no `EXPLAIN ANALYZE` against production-volume data.
- **Concurrency.** Optimistic locking (`lockVersion`) is configured on the master models and returns 409 via `sendError`, but simultaneous-edit behaviour was not exercised under real contention.

---

## Summary

The Master Data module was **not production-ready**. It presented as complete — every master had a screen, a model, an API and a route — and the underlying architecture is genuinely well built. But the guarantees an ERP's master data has to make were mostly absent: duplicates were freely creatable, deleting a product destroyed its BOM history, `inactive` was a decorative badge, BOMs could be circular, sorting was fabricated in the browser, six masters wrote no audit trail, and `count()` leaked across tenants. The whole suite was also red on arrival from a model/migration drift that broke every user insert.

23 of 32 audit assertions failed at the start; all 32 pass now, alongside 16 end-to-end assertions that follow real master data through sales, purchasing, production, invoicing, payments, the ledger and the reports. The full backend suite went from 242 to 290 passing with no regressions.

Four items are documented but deliberately not built — Sales Reference attachment, Vehicle, Payment Mode and Expense Category masters — because each modifies a module outside this audit's scope or invents a master the current requirements do not justify. Each is written up in §3 with its full impact so the decision to build it can be made on the business case rather than rediscovered later.
