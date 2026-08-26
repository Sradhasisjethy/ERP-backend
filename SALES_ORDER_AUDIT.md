# Sales & Order Management — Audit and Production Hardening

**Date:** 2026-08-19
**Scope:** M06 Sales Orders, M07 Stock Reservation, M15 Dispatch, M20/M21 Invoicing, M18/M24 Receipts, and their integration with Inventory, Ledger, Reports and the Audit Log.
**Method:** every claim traced UI → hook → API → route → middleware → controller → service → model → migration → SQL, then executed. No status is asserted from reading code alone.

**Stack note:** the backend is PostgreSQL + Sequelize (not MongoDB). Same correction as the Master Data audit; it matters here because the fixes turn on row-level locking (`SELECT … FOR UPDATE`) and partial unique indexes.

---

## 1. Architecture assessment

**Verdict: PASS on structure. The module is well factored; what it lacked were guarantees at the boundaries.**

| Layer | Assessment |
|---|---|
| Service boundaries | Sales / Dispatch / Invoicing / Payments are cleanly separated, each owning its own document. No cross-writing of another module's tables. |
| Stock ledger | **Genuinely well built.** `StockLedgerService.postEntry` is the *only* writer of `StockLot.qtyAvailable`, it refuses to run without a transaction, and it takes `FOR UPDATE` on the lot. `consumeFifo` locks its whole candidate set. This is why no double-deduction or oversell was found anywhere. |
| Reservation model | Soft reservations in a separate `stock_reservations` table, never mutating lot quantities. Holds become `CONSUMED` on dispatch and `RELEASED` on cancel, so reporting can tell "the customer took it" from "we gave up". Correct design. |
| Ledger integration | Every invoice, receipt and payment posts a balanced journal via `LedgerService.postJournal`; cancellation posts a reversing entry rather than deleting. Correct. |
| Document numbering | Gap-free, row-locked, retry-on-race. Correct **within a series** — the defect was in how series relate to each other (§4 S1). |
| Money | Integer paise end to end, `roundToRupee` at invoice level with an explicit `roundOffPaise` line in the journal. Correct. |
| Multi-tenancy | CLS-injected `tenantId` via model hooks — correct for finders, **broken for aggregates** (§6 S2). |
| Location (BR-29) | Logic existed in `core/factoryAccess.js` and was applied by the dashboard and reports — and **by nothing else** (§6 S3). |
| Status lifecycle | Seven enum values, transitions guarded by ad-hoc `if`s spread across two services, three values unreachable, no central definition (§4 S4). |

**Structural weakness:** the order lifecycle had no single owner. `sales.service.js` guarded confirm/cancel/short-close; `dispatch.service.js` independently recomputed the same status field from dispatch quantities. Nothing described which moves were legal, so each new action re-derived the rules and `IN_PRODUCTION` was simply never reached by any of them.

---

## 2. The business flow, traced

| Step | Exists | Verified by | Status |
|---|---|---|---|
| Customer | `Party(CUSTOMER)` | type + active guard at order entry | **PASS** |
| Sales Order | `SalesOrder` + `SalesOrderLine` | full lifecycle test | **PASS** (after fixes) |
| Order Validation | zod schema + service rules | quantity/rate/date/duplicate-line tests | **PASS** (after fixes) |
| Stock Availability | `ReservationService.getAvailability` | ATP excludes curing, reserved and in-transit | **PASS** |
| Stock Reservation | `stock_reservations`, FIFO by lot | concurrency test, 100 units never over-held | **PASS** |
| Production Requirement | `SalesOrderLine.productionRequired` | shortfall of 100 booked when nothing in stock | **PASS** |
| Production | `production.service` → `BomService.resolveForDate` | consumes 2/unit per BOM, yields the lot | **PASS** |
| Finished Goods | `StockLot` via `postEntry` | on-hand 100 after production | **PASS** |
| Delivery Challan / Dispatch | `DispatchService.createChallan` | 100 → 40 → 30 → pending 30 | **PASS** (after fixes) |
| Inventory OUT | `consumeFifo` → `SALE_OUT` | exactly 70 units out, exactly one entry per dispatch | **PASS** |
| Sales Invoice | `InvoicingService` | numbering, GST from shipping address, round-off | **PASS** (after fixes) |
| Payment | `PaymentsService.createReceipt` | partial, full, over-allocation, cancel/re-allocate | **PASS** (after fixes) |
| Customer Ledger | `journal_lines` on `ACCOUNTS_RECEIVABLE` | closes at nil after full settlement | **PASS** |
| Receivables | `customer/outstanding` report | served, scoped, populated | **PASS** |
| Reports | 8 report paths | all 200, containing the customer | **PASS** |
| Audit Log | `BaseAuditedModel` | every status change with before/after, attributed | **PASS** |

**One documented break in the chain:** *Sales Reference* (§5.4). The `SALES_REF` party type exists, but no sales document carries a reference party — so sales cannot be attributed. The reports module already declares this as a known limitation.

---

## 3. Sales Order — capability matrix

| Capability | Before | After | Note |
|---|---|---|---|
| Create | ✅ | ✅ | |
| View | ❌ | ✅ | No read-only detail existed at all; the list showed header fields only, and the edit path did not exist, so for any order past DRAFT there was **no way to see what was ordered or what was pending**. Added. |
| Edit | ❌ | ✅ | No `PUT /sales/orders/:id` and no service method. A draft with a wrong quantity had to be cancelled and re-keyed, burning an order number. Added, DRAFT-only. |
| Cancel | ✅ | ✅ | |
| Short-close | ✅ | ✅ | |
| Approve | N/A | N/A | Sales orders have no approval step in this system — `PURCHASE_APPROVE` exists for indents, deliberately. Not invented. |
| Search | ❌ | ✅ | The controller read `search` and the service silently discarded it — the search box was decorative. Now searches order number, PO reference and customer name. |
| Filters | ⚠️ | ✅ | `factoryId` / `customerPartyId` / `status` worked at the API; no status filter existed in the UI. Added. |
| Sorting | ❌ | ✅ | Schema accepted `sortBy`/`sortDir`; service hardcoded `orderDate DESC`. Now allow-listed and server-side. |
| Pagination | ✅ | ✅ | |
| Status lifecycle | ⚠️ | ✅ | Ad-hoc per action, `IN_PRODUCTION` unreachable. Now a central transition table. |
| Customer validation | ✅ | ✅ | Type + active, added during the Master Data audit. |
| Product validation | ⚠️ | ✅ | Existence + active existed; duplicate lines did not (§4 S5). |
| Quantity validation | ✅ | ✅ | `positive()` at the schema. |
| Price validation | ✅ | ✅ | Integer paise, `min(0)`. |
| Discount | ❌ | ❌ | **No discount field anywhere** in the sales chain — see §5.1. Not implemented. |
| Tax | ✅ | ✅ | At invoice, per HSN, intra/inter-state from the shipping address. Correctly *not* on the order. |
| Location | ❌ | ✅ | See §6 S3 — the largest defect found. |
| Sales reference | ❌ | ❌ | §5.4. Not implemented. |
| Delivery date | ⚠️ | ✅ | Stored and used by the overdue job; nothing stopped it preceding the order date. |
| Organization | ✅ | ✅ | Verified by cross-tenant test. |
| Permissions | ✅ | ✅ | Server-side, verified by direct API call. |

### Status lifecycle, as now defined

```
DRAFT ──confirm──▶ CONFIRMED ──▶ IN_PRODUCTION
  │                   │  ▲            │
  │                   │  └────────────┘
  │                   ├──▶ PARTIALLY_DISPATCHED ──▶ DISPATCHED
  │                   │            │                    │
  └──cancel──▶ CANCELLED           └──▶ SHORT_CLOSED ◀──┘
```

`CANCELLED` and `SHORT_CLOSED` are terminal. The reverse edges (`DISPATCHED → PARTIALLY_DISPATCHED → CONFIRMED`) exist because cancelling a challan legitimately walks the order back. Enforced centrally by `assertTransition`, so an action cannot forget its own rule.

---

## 4. Broken flows found

| # | Defect | Severity | Status |
|---|---|---|---|
| **S1** | **A multi-plant tenant could not transact at its second plant at all.** Document numbers are allocated per `(documentType, factoryId, financialYearId)` — the sequence restarts at 1 for each factory — but the unique index on every document is `(tenantId, number)`, i.e. tenant-wide. So the second factory's first sales order, challan, invoice, receipt, GRN, transfer or production entry allocated `SO/0001` again and was rejected with a bare *"A record with these details already exists."* naming nothing. The workaround was to hand-create ten `DocumentSeries` rows per factory before going live — a setup step nothing enforced, defaulted or documented outside one test fixture's comment. | **P0** | **FIXED** — the default prefix now includes the factory code (`SO/PA/0001`), keeping numbers unique tenant-wide (which GST also requires of an invoice series). An explicitly configured prefix is still honoured; existing series rows are untouched. |
| **S2** | **`Model.sum()` ignored the tenant filter**, so BR-13 credit control summed open orders across *every tenant on the platform*. One tenant's volume could block another tenant's customer, and a genuinely over-limit order could pass. Proven directly: same query, `findAll` → 1 row, `sum` → both tenants' money. | **P0** | **FIXED** |
| **S3** | **No location scoping on any transactional endpoint.** A user assigned only to Plant B could list and open every Plant A sales order, challan, invoice and receipt, could query Plant A's stock availability, and could **raise documents against Plant A** by naming its id. BR-29 was enforced on dashboards and reports and nowhere else. | **P0** | **FIXED** |
| **S4** | **No status transition machine.** Guards were ad-hoc per action across two services; `IN_PRODUCTION` was in the enum, in `ACTIVE_ORDER_STATUSES` and in the dashboard's open-order filter but **nothing ever set it** — an order waiting on manufacture was indistinguishable from one ready to ship. | **P1** | **FIXED** |
| **S5** | **Two lines for the same product corrupted the production requirement.** Each line computed `productionRequired` against the *same* availability snapshot, so 60 + 60 against 100 units booked zero production requirement on both lines instead of 20. Reservation, dispatch tolerance and the production sheet all inherited the error. | **P1** | **FIXED** |
| **S6** | **Concurrent dispatches lost updates.** Two challans against one order both read `dispatchedQty = 0`, both passed the BR-14 tolerance check, and both wrote their own total — so 60 + 60 against a 100-unit order left the line reading 60 while 120 units physically shipped. Stock itself stayed correct (the ledger locks lots), but the order, the pending balance and the invoice did not. | **P1** | **FIXED** — `FOR UPDATE` on the order row serialises dispatch. |
| **S7** | **Concurrent receipts double-paid an invoice.** Both read "nothing allocated yet", both passed the over-allocation check. | **P1** | **FIXED** — `FOR UPDATE` on the invoice row. |
| **S8** | **Cancelling a receipt never released its invoice.** `getInvoiceAllocatedAmount` joined Receipt and Payment with `required: false`, so Sequelize emitted LEFT JOINs with `status = 'POSTED'` in the *ON* clause — an allocation whose receipt had been CANCELLED was not filtered out, just returned with null columns, and its amount was still summed. The money was reversed in the ledger but the invoice still looked paid, and a corrected receipt was rejected with "allocation exceeds the outstanding balance". **A mis-keyed receipt was unrecoverable.** | **P1** | **FIXED** — one INNER JOIN per parent type. |
| **S9** | **An invoice with money against it could be cancelled.** That reverses the receivable while the receipt's credit stays behind, so the customer's ledger shows money the business never owed and receivables stop reconciling. | **P1** | **FIXED** — refused, naming the amount received and pointing at cancelling the receipt or raising a credit note. |
| **S10** | **A receipt could settle another customer's invoice.** One customer's ledger credited, a different customer's invoice cleared — both balances wrong, neither obviously so. Same on the vendor side. | **P1** | **FIXED** |
| **S11** | Search accepted and silently dropped; sorting accepted and ignored (§3). | **P1** | **FIXED** |
| **S12** | No edit path for a DRAFT order (§3). | **P1** | **FIXED** |
| **S13** | `expectedDeliveryDate` could precede `orderDate`. | **P2** | **FIXED** |

---

## 5. Missing functionality

Identified first, with impact. Implemented only where legitimate.

### 5.1 Discount — **P1, NOT IMPLEMENTED**

- **Missing:** no discount field on the sales order, its lines, the invoice or its lines. There is no way to record a negotiated price reduction other than by editing the rate itself, which destroys the record of what the list price was.
- **Business reason:** discount is a reportable, approvable quantity in its own right — "what did we give away, to whom, and who authorised it" is a standard margin control.
- **Frontend impact:** discount % / amount per line plus an order-level discount, with the net recomputed live.
- **Backend impact:** `discountPercent` / `discountPaise` on `sales_order_lines` and `sales_invoice_lines`, an order-level field, and rework of the taxable-amount calculation in `invoicing.service.js` — GST is charged on the post-discount value, so this changes tax on every invoice.
- **Database impact:** four new columns plus a backfill of zeros.
- **Downstream impact:** invoice totals, the GST return, sales reports, margin analysis.
- **Why not implemented:** it changes the taxable value on every invoice and therefore the GST computation and the filed return. That is a pricing-and-tax design decision (line-level vs order-level, before or after tax, whether it needs an approval grant) that needs a business answer before code. Rushing it into a sales audit would produce invoices whose tax I cannot justify.

### 5.2 Sales order approval — **N/A**

The system has no approval step for sales orders, and the permission catalog grants approval only for purchase indents (`PURCHASE_APPROVE`), deliberately. Credit control (BR-13) is the sales-side gate and it works, including the `SALES_CREDIT_OVERRIDE` escape. Not invented.

### 5.3 Invoice payment status field — **P2, NOT IMPLEMENTED**

`PurchaseInvoice` carries a `paymentStatus` column kept in sync on allocation; `SalesInvoice` does not — sales settlement is derived from allocations and the ledger. The derivation is correct (verified: receivables close at nil), but the asymmetry means a sales invoice cannot be filtered by paid/unpaid without joining allocations. Adding a denormalised column means keeping it correct across receipt, cancel, bounce and credit note — worth doing deliberately, not as a side effect of this audit.

### 5.4 Sales Reference attachment — **P1, NOT IMPLEMENTED**

Carried forward from the Master Data audit: the `SALES_REF` party type exists and is fully manageable, but no sales document references one, so sales cannot be attributed to an agent. Needs `salesRefPartyId` on `sales_orders` and `sales_invoices` carried through the flow, plus a report column. Deferred for the same reason as before — it is a schema change to transactional tables driven by a commission requirement that has not been specified.

---

## 6. Security

| # | Finding | Severity | Status |
|---|---|---|---|
| **S2** | Tenant isolation bypassed by aggregates (`sum`/`min`/`max`). `count` had been fixed in the previous audit via `beforeCount`; `sum` fires **no hook at all**. Now closed at the `Model.aggregate` level, which every aggregate — `count` included — funnels through. | **P0** | **FIXED** |
| **S3** | Location isolation absent on sales, dispatch, invoicing and payments. Verified fixed across list, read, create and dispatch for all four modules plus the ATP endpoint and the reports. | **P0** | **FIXED** |
| — | Organization (tenant) isolation on all sales documents | — | **PASS** — verified, no defect |
| — | RBAC on every sales write, by direct API call with no UI | — | **PASS** — verified, no defect |
| — | Unauthenticated access | — | **PASS** — 401 |
| — | BR-27 rate masking (`totalAmountPaise` stripped without `VIEW_RATES`) | — | **PASS** — verified server-side |
| — | BR-28 PO attachment gating | — | **PASS** — already enforced in the controller |

**On 404 vs 403 for cross-location reads:** `assertCanSeeRecord` returns **404**, not 403. A user who may not see Plant A should not be able to confirm that a given order id exists there — 403 leaks document volumes and numbering across locations. Creating *for* a forbidden factory returns 403, because there the caller named the factory explicitly and is entitled to know the answer.

### Verified isolation matrix (Plant-B-only user)

| Endpoint | Plant A | Plant B |
|---|---|---|
| `GET /sales/orders` | excluded from list ✅ | listed ✅ |
| `GET /sales/orders/:id` | 404 ✅ | 200 ✅ |
| `POST /sales/orders` | 403 ✅ | 201 ✅ |
| `GET /sales/atp` | 403 ✅ | 200 ✅ |
| `GET /dispatch/challans` | excluded ✅ | listed ✅ |
| `GET /invoices` | excluded ✅ | listed ✅ |
| `GET /receipts` | excluded ✅ | listed ✅ |
| `GET /reports/sales/summary?factoryId=A` | 403 ✅ | — |
| `GET /reports/sales/summary` (no filter) | Plant A absent from the payload ✅ | — |

---

## 7. Concurrency

Every case the brief names was executed as two genuinely parallel HTTP requests, then the resulting data checked for arithmetic consistency.

| Scenario | Before | After |
|---|---|---|
| **Concurrent order creation** | Safe — document numbering is row-locked with retry. | **PASS** |
| **Concurrent stock reservation** | Safe — `reserve()` takes `FOR UPDATE` on the candidate lots before reading existing holds. Two 80-unit orders against 100 units correctly split into 100 held + 60 production-required. | **PASS** |
| **Concurrent dispatch** | **BROKEN** (S6) — both wrote 60 against a 100 order; the line read 60 while 120 shipped. | **FIXED** — exactly one succeeds; recorded quantity equals the stock that actually moved. |
| **Concurrent invoice creation** | Safe — challans are flagged `invoiced` inside the transaction and re-invoicing is refused. | **PASS** |
| **Concurrent payment** | **BROKEN** (S7) — an invoice could be paid twice. | **FIXED** — exactly one succeeds; total allocated equals the invoice total. |
| **Oversell under concurrency** | Safe throughout — `postEntry` refuses to run without a transaction and locks the lot. | **PASS** |

---

## 8. Inventory integration

**Stock changes exactly once.** Verified by counting ledger entries rather than trusting balances:

- Two dispatches of 40 and 30 against a 100 order → exactly two `SALE_OUT` entries totalling 70; on-hand falls 200 → 130.
- Cancelling a challan → exactly one `REVERSAL` entry against exactly one `SALE_OUT`; on-hand returns to its prior value and `dispatchedQty` returns to 0.
- Cancelling a challan **re-holds** the returned stock for the same order rather than releasing it to the pool (FR-M15-9) — correct, the order is still live.
- **Invoice cancellation does not touch stock** — correct. Stock moves at dispatch, not at invoice; reversing it at invoice would be the double-count the brief warns about.

No double-deduction was found anywhere. This is a direct consequence of `postEntry` being the single writer.

---

## 9. Reporting

All eight reports the brief names were called and returned 200 with data, scoped to the caller's factories:

| Brief's report | Catalog path | Result |
|---|---|---|
| Sales Summary | `sales/summary` | **PASS** — contains the customer |
| Sales Detail | `sales/detail` | **PASS** |
| Customer Sales | `sales/by-customer` | **PASS** |
| Product Sales | `sales/by-product` | **PASS** |
| Location Sales | `sales/by-location` | **PASS** |
| Sales Reference | — | **N/A** — no such report can exist; see §5.4 |
| Pending Orders | `orders/pending` | **PASS** — the 30-unit undelivered balance appears |
| Receivables | `customer/outstanding` | **PASS** |
| Customer Ledger | `customer/ledger` | **PASS** — closes at nil after settlement |

---

## 10. UI/UX

| # | Issue | Severity | Status |
|---|---|---|---|
| U1 | **No way to see an order's lines.** The list showed header fields; there was no detail view and no edit path, so for any order past DRAFT the ordered/dispatched/pending quantities were invisible in the UI. | P1 | **FIXED** — read-only detail dialog with ordered, dispatched, pending and to-produce per line. |
| U2 | No edit for a DRAFT order. | P1 | **FIXED** — the form dialog now does both, factory locked on edit. |
| U3 | **No RBAC gating** — every user saw New / Confirm / Cancel / Short-close. The API refused them correctly; the UI invited a guaranteed failure. | P2 | **FIXED** |
| U4 | **Failed actions vanished silently.** No `onError` on any mutation, so a refused confirm (stock shortfall, invalid transition, forbidden location) simply left the row unchanged with no explanation. | P1 | **FIXED** — server's message surfaced in an alert band. |
| U5 | Search box present but non-functional (S11). | P1 | **FIXED** |
| U6 | Sorting sorted only the fetched page. | P1 | **FIXED** — server-side, allow-listed. |
| U7 | No status filter. | P2 | **FIXED** — status tabs. |
| U8 | No "In production" action (the status was unreachable). | P1 | **FIXED** |
| U9 | Duplicate product / bad delivery date only caught server-side. | P2 | **FIXED** — checked in the dialog first, naming the product. |
| U10 | Generic empty state. | P2 | **FIXED** |
| — | Loading skeletons, credit-override retry flow, per-line availability hint | — | Already correct — the credit-override retry is a nice piece of work. |

---

## 11. Database

No schema migration was required for this module. The fixes are behavioural.

| Aspect | Finding |
|---|---|
| Unique constraints | Present on every document number, `(tenantId, number)`. Correct — the defect was that the *allocator* did not respect that scope (S1), now fixed in the allocator rather than by weakening the index. |
| Indexes | `rpt_sales_orders_*`, `rpt_sales_invoices_*`, `rpt_delivery_challans_*` etc. added by the earlier reporting migration cover the `(tenantId, factoryId, date)` and `(tenantId, customerPartyId)` shapes the new location-scoped list queries use. No new index needed. |
| Foreign keys | `RESTRICT` throughout the sales chain — history cannot be orphaned. |
| Optimistic locking | `SalesOrder` has `lockVersion`; `SalesOrderLine`, `DeliveryChallan` and `SalesInvoice` do not. Left as is — the races that mattered (S6, S7) are cross-request and are now handled by pessimistic `FOR UPDATE` locks, which are strictly stronger. Adding optimistic locking on top would add failure modes without adding protection. |
| Soft deletion | None; documents are cancelled, never deleted, and cancellation preserves the number. Correct for an ERP. |

---

## 12. Performance

| # | Issue | Severity | Status |
|---|---|---|---|
| PF1 | The order-list search now joins `parties` and uses `subQuery: false` to allow `$customer.name$` in the where. Covered by `rpt_sales_orders_tenant_customer`. | — | Acceptable |
| PF2 | `scopeListToFactories` issues one `user_factories` lookup per request. | P2 | Accepted — a single indexed lookup, and it is skipped entirely for bypass roles. |
| PF3 | `getInvoiceAllocatedAmount` is now two queries instead of one. | P2 | Accepted — correctness over a round trip; both are indexed and it only runs during allocation. |
| PF4 | `promoteEligibleLots` runs a bulk UPDATE on every availability read. | P2 | Pre-existing, deliberate (documented in the service). Not changed. |

---

## 13. Files changed

### Backend — new (3)

| File | Purpose |
|---|---|
| `src/core/salesScope.js` | BR-29 location scoping helpers for transactional modules: `scopeListToFactories`, `assertCanUseFactory`, `assertCanSeeRecord`. |
| `tests/sales-order-audit.test.js` | 45 assertions — the audit's evidence and its regression guard. |
| `tests/sales-order-e2e.test.js` | 13 assertions — the brief's complete flow as one continuous scenario. |

### Backend — modified (9)

| File | Change |
|---|---|
| `src/core/BaseModel.js` | **`aggregate` override** — closes the `sum`/`min`/`max` tenant leak (S2). |
| `src/api/documentSeries/documentNumbering.service.js` | **Factory-qualified default prefix** — makes multi-plant operation possible (S1). |
| `src/api/sales/sales.service.js` | Central `ORDER_TRANSITIONS` + `assertTransition`; `updateSalesOrder` (DRAFT-only); `markInProduction`; duplicate-line and date validation; search across order number / PO / customer; allow-listed sorting; credit check excludes the order being edited. |
| `src/api/sales/sales.controller.js` | Location scoping on list, read, create and every mutation; new edit and in-production handlers. |
| `src/api/sales/sales.router.js` / `sales.schema.js` | `PUT /orders/:id`, `PUT /orders/:id/in-production`, `updateSalesOrderSchema`. |
| `src/api/dispatch/dispatch.service.js` / `.controller.js` | `FOR UPDATE` on the order before dispatch (S6); location scoping. |
| `src/api/invoicing/invoicing.service.js` / `.controller.js` | Refuse to cancel an invoice with money against it (S9); location scoping. |
| `src/api/payments/payments.service.js` / `.controller.js` | Allocation sum via INNER JOIN so cancelled parents drop out (S8); `FOR UPDATE` on the invoice (S7); invoice-belongs-to-party check both sides (S10); location scoping. |

### Frontend — new (1) / modified (2)

| File | Change |
|---|---|
| `src/components/sales/sales-order-detail-dialog.jsx` | **New** — read-only order view with per-line ordered / dispatched / pending / to-produce. |
| `src/pages/SalesOrdersPage.jsx` | RBAC gating, status tabs, server sorting, working search, view + edit + in-production actions, error surfacing, empty state. |
| `src/components/sales/sales-order-form-dialog.jsx` | Create **and** edit; factory locked when editing; client-side duplicate-product and delivery-date checks. |
| `src/hooks/use-sales.js` | `useUpdateSalesOrder`, `useMarkInProduction`. |

---

## 14. Tests executed

| Run | Suites | Tests | Result |
|---|---|---|---|
| Baseline (before this audit) | 24 passed, 2 failed | 290 passed, 2 failed | The 2 are pre-existing date-sensitive curing tests. |
| Sales audit suite, **before** fixes | — | **0 passed / 43 failed** | Setup itself could not complete: stocking the same product at a second factory hit the S1 document-number collision. |
| Sales audit suite, **after** fixes | — | **45 / 45 passed** | |
| Sales end-to-end flow | — | **13 / 13 passed** | |
| **Final full suite** | **26 passed, 2 failed** | **348 passed, 2 failed** | Same 2 pre-existing failures. **No regressions.** |

Frontend: `vite build` clean (1917 modules); `eslint src` 0 errors, 7 pre-existing warnings in untouched UI primitives.

### What the 45 audit assertions cover

Full status walk DRAFT → CONFIRMED → PARTIALLY_DISPATCHED → DISPATCHED · double-confirm refused · confirm/cancel/short-close on a CANCELLED order refused · cancel-after-dispatch refused with the short-close instruction · short-close without dispatch refused · dispatch against a cancelled order refused · IN_PRODUCTION reached and refused from DRAFT · draft edit changes lines, quantities, rates and total · edit of a CONFIRMED order refused · zero/negative quantity and negative rate refused · empty line set refused · delivery date before order date refused · duplicate product line refused · search by order number and by customer name · sort ascending and descending across the whole result set · status filter and pagination · audit trail with attribution · reservation reduces ATP by exactly the confirmed quantity · partial reservation books the balance as production · cancel and short-close release the hold · Plant B stock never covers a Plant A order · two concurrent confirmations never over-hold · 100 → 40 → 30 → pending 30 with stock out exactly once per dispatch · over-dispatch beyond tolerance refused · two concurrent dispatches never over-dispatch · challan cancel reverses stock exactly once · invoice numbered, totalled, rounded to the rupee · same challan invoiced twice refused · invoice with an allocated receipt cannot be cancelled · unpaid invoice cancels and stays readable · partial then settling payment, third refused · allocation exceeding the receipt refused · cancelled receipt frees the invoice for re-allocation · cross-customer allocation refused · two concurrent receipts never over-allocate · cross-tenant leakage on orders/challans/invoices/receipts · Plant-B confinement on list, read, create, dispatch, ATP, invoices, receipts and reports · RBAC on every write · rate masking · credit limit scoped to the tenant · credit block and authorised override · eight sales reports served and populated.

### Not verified

- **Browser-rendered UI** — verified by build, lint and code trace, not by driving a browser.
- **Load at production volume** — no `EXPLAIN ANALYZE` against realistic data.
- **Concurrency beyond two parties** — every race was exercised with two simultaneous requests, which is enough to expose a missing lock but not to characterise behaviour under heavy contention.
- **Cheque bounce reversing a sales receipt** — the cheque lifecycle exists and is tested elsewhere; its interaction with the new invoice-cancel guard was not specifically exercised.

---

## Summary

The sales module was **not production-ready for a multi-plant tenant, and not safe under concurrency.**

The single worst defect was not in the sales logic at all: document numbers were allocated per factory but enforced unique per tenant, so **a tenant's second plant could not create a sales order, challan, invoice or receipt at all**. The audit suite could not even build its own fixtures until that was fixed. Alongside it, `Model.sum()` silently ignored the tenant filter — meaning credit control was computing customers' exposure across every tenant on the platform — and BR-29 location isolation, which exists and works in `core/factoryAccess.js`, was applied by the dashboard and reports and by no transactional endpoint whatsoever.

Underneath those, the module is well built. The stock ledger's single-writer discipline and lot-level locking meant that despite two genuine lost-update races (dispatch, payment allocation), **no double-deduction or oversell was ever possible** — the damage was confined to document quantities and allocations, which is exactly where the fixes went.

43 assertions could not even run at the start; 45 pass now, plus 13 that walk the brief's complete flow — customer through order, validation, availability, reservation, production requirement, production, finished goods, dispatch, invoice, payment, ledger, receivables, reports and audit log — as one continuous scenario. The full suite went from 290 to 348 passing with no regressions.

Three things are documented but deliberately not built: **discount** (changes the taxable value on every invoice, so it needs a business decision before code), **sales-reference attribution**, and a denormalised **sales invoice payment status**. Each is written up in §5 with its full impact.
