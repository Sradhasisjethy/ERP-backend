# Inventory / Warehouse Management — Audit

**Date:** 2026-08-19
**Scope:** every operation in the system that can change stock, the ledger/balance model beneath them, reservations, transfers, adjustments, negative-stock control, concurrency, and the eight inventory reports.
**Method:** every mutation path traced to source, then executed. The reconciliation in §11 is the basis for every PASS below — no stock number is called correct on the strength of reading code.

**Stack:** PostgreSQL + Sequelize.

---

## 1. Verdict

**The inventory engine is the strongest subsystem in this application.** It has a genuine ledger/balance separation, a single authoritative writer, mandatory transactions, row-level locking, and a nightly self-reconciliation. The mutation matrix, the ledger↔balance identity, reservations, negative-stock control and the two-users-one-stock race **all passed before any change was made**. That is not the usual result.

It had one hole, and it was a large one: **the system could not record a physical stock count.** `ADJUSTMENT_IN` and `ADJUSTMENT_OUT` were in the ledger's enum, in the report filter vocabulary, and behind a whole "Stock Adjustments" report — and the only code that ever wrote one was the one-time opening-balance importer. A warehouse counting 92 against a system figure of 100 had no way to correct the difference, because every other movement type requires a business document that did not happen. The Stock Reconciliation report said so in its own `limitations` text: *"there is no physical stock-count entity in this schema."*

---

## 2. Stock mutation matrix

Every operation that can change stock, as verified by execution. "Ledger entries" is what each one actually writes.

| # | Transaction | Stock IN | Stock OUT | Reservation | Ledger entries | Status |
|---|---|---|---|---|---|---|
| 1 | Opening Stock (migration import) | YES | — | — | `ADJUSTMENT_IN` | **PASS** |
| 2 | Purchase (Goods Receipt) | YES | — | — | `PURCHASE_IN` ×1 | **PASS** |
| 3 | Purchase Return | — | YES | — | `RETURN_OUT` ×1 | **PASS** |
| 4 | Sale (Delivery Challan) | — | YES | consumes hold | `SALE_OUT` ×1 | **PASS** |
| 5 | Sales Return | YES | — | — | `RETURN_IN` ×1 | **PASS** |
| 6 | Production — raw material | — | YES | — | `PRODUCTION_OUT` per BOM line | **PASS** |
| 7 | Production — finished goods | YES | — | — | `PRODUCTION_IN` ×1 | **PASS** |
| 8 | Stock Transfer — send | — | YES (source) | — | `TRANSFER_OUT` ×1 | **PASS** |
| 8 | Stock Transfer — receive | YES (destination) | — | — | `TRANSFER_IN` ×1 | **PASS** |
| 9 | **Stock Adjustment** | if surplus | if shortfall | — | `ADJUSTMENT_IN`/`OUT` ×1 | **was FAIL → now PASS** |
| 10 | Stock Reservation | — | — | YES | **none** | **PASS** |
| 11 | Reservation Release | — | — | releases | **none** | **PASS** |
| 12 | Cancellation (receipt / challan / transfer / return) | reverses | reverses | re-holds where the order is still live | `REVERSAL` ×1, linked to the original | **PASS** |
| 13 | Wastage / breakage | — | YES | — | `BREAKAGE_OUT` ×1 | **PASS** |
| 13 | Contractor issue / return | YES/OUT | YES/OUT | — | `CONTRACTOR_ISSUE_OUT` / `_IN` | **PASS** |
| — | Curing promotion (BR-08) | — | — | — | **none** — a status change, not a movement | **PASS** (correct) |

Two properties worth calling out because they are easy to get wrong and this system gets both right:

- **A reservation writes no stock movement.** Verified explicitly: confirming and then cancelling an order leaves the ledger entry count and every lot balance untouched. Reservations reduce what may be *promised*, never what is *held*.
- **A cancellation is a new opposite entry, never an edit or a delete.** The reversal carries `reversalOfEntryId` pointing at the original, and the original's quantity is unchanged afterwards. The ledger is genuinely append-only.

---

## 3. Core model — balance vs movement

**PASS. The separation is real and correct.**

| Concern | Where it lives |
|---|---|
| Movement / ledger | `stock_ledger_entries` — immutable, append-only, one row per movement, with direction, type, reference and user. |
| Balance | `stock_lots.qtyAvailable` — a **derived projection**, per lot. |
| Recovery | `StockLedgerService.rebuildStockBalances()` recomputes every balance straight from the ledger. |
| Drift detection | `StockLedgerService.reconcileLedgerVsBalances()` compares the two and returns every disagreement. **Run nightly** by `jobs/nightly.js`. |

The identity the brief asks for — `Balance = Opening + IN − OUT ± Adjustments` — holds, and is proven per step in §11 rather than asserted. Rebuilding all balances from the ledger reproduces the existing numbers exactly, which is the strongest statement available: the projection is fully reconstructible from the immutable record.

### One authoritative service — confirmed

`StockLedgerService.postEntry` is **the only** function in the codebase that writes `StockLedgerEntry` or mutates `StockLot.qtyAvailable`. Verified by grepping every write site: purchasing, dispatch, transfer, production, returns, workforce, migration and the new adjustment service all route through it. Nothing computes stock independently.

It also refuses to run without a transaction — an explicit guard with the reasoning in place, because without one the row lock below it would be meaningless. That single decision is why no double-deduction or oversell was found anywhere across four audits.

---

## 4. Defects found

| # | Defect | Severity | Status |
|---|---|---|---|
| **I1** | **No stock adjustment operation existed.** Enum values, report filters and a full Stock Adjustments report, with no API, service or screen behind them. A physical count discrepancy could not be recorded at all. | **P0** | **FIXED** |
| **I2** | **No location scoping on any inventory endpoint.** `/inventory/lots`, `/ledger` and `/balance` took `factoryId` as an optional filter and applied no restriction when it was omitted — so a user assigned to one plant could read every plant's stock position and movement history. The same gap found and fixed in sales and purchasing. | **P0** | **FIXED** |
| **I3** | **The balance endpoint contradicted the ledger.** `GET /inventory/balance` returned a single number counting `AVAILABLE` lots only, so a warehouse holding 70 units still curing was told its balance was **0** — with no way to ask what was physically on the floor. That figure disagrees with the movement ledger by construction, which is exactly what a reconciliation is meant to catch. | **P1** | **FIXED** — now returns `onHand`, `available`, `curing`, `reserved`, `inTransit` alongside the original `balance` field, which keeps its meaning for existing callers. |
| **I4** | `search` was accepted by the stock-ledger query schema and silently discarded by the service. Sorting was accepted and ignored on both lots and ledger. | **P2** | **FIXED** |
| **I5** | No RBAC gating, error surfacing or server-side sorting on the Inventory screen. | **P2** | **FIXED** |

### What was *not* wrong — verified, not assumed

| Checked | Result |
|---|---|
| Duplicate stock calculations | **None.** Single writer confirmed by exhaustive grep. |
| Double-deduction on any path | **None.** Entry counts asserted per operation, not just balances. |
| Reservation arithmetic (`available = physical − reserved`) | **Correct**, including partial holds and shortfall reporting. |
| Curing stock counted as available | **Never** — reserved and available both exclude it. |
| Transfer conservation | **Holds.** Source OUT on send, destination IN on receive, in-transit owned by neither, total conserved. |
| Transfer atomicity | **Correct.** Send and receive are separate transactions because the goods physically move over time; the destination lot and its IN entry are created in one transaction, so a failed receive rolls both back and the transfer stays `IN_TRANSIT` with the stock visible as in-transit rather than lost. |
| Negative stock blocked server-side | **Yes** — in `postEntry`, not in the UI. |
| Two-users-one-stock race | **Safe** — see §7. |
| Tenant isolation on lots and ledger | **Correct.** |

---

## 5. Stock adjustment — what was built

A `stock_adjustments` document recording exactly what an auditor asks for:

| Requirement | Field |
|---|---|
| Reason | `reason` — mandatory, minimum length enforced at the schema and the service |
| Previous quantity | `previousQty` — read **under the row lock** the posting uses |
| Adjustment quantity | `adjustmentQty` — signed; negative is a shortfall |
| New quantity | `newQty` |
| User | `createdBy`, plus a full `AuditLog` entry with before/after snapshots |
| Location | `factoryId`, and the lot it was counted against |
| Audit | Append-only; a wrong adjustment is corrected by making another one |
| Approval | **Not implemented** — see §9 |

Two design decisions worth stating:

**The API takes the counted quantity, not the difference.** That is what makes it safe under concurrency: the service reads the system quantity under the same `FOR UPDATE` lock it posts with, so two people counting the same lot cannot both apply a delta computed against a stale figure. The UI shows the difference live so nobody has to do the arithmetic, but the number that crosses the wire is the count.

**The document does not move stock — `postEntry` does.** An adjustment is an ordinary ledger entry with an explanation attached, so it inherits the lot lock, the negative-stock rule and the reconciliation guarantee unchanged. Nothing about adjustments is special-cased in the stock engine, which is why §11 reconciles with an adjustment in the middle of it.

It is gated on `INVENTORY_CREATE`, not `INVENTORY_READ` — writing stock with no business document behind it is a materially different act from reading it. Verified: a read-only user gets 403, and a Plant-B user adjusting Plant-A stock gets 403.

---

## 6. Reservations

**PASS, unchanged.** `available = sellable − reserved`, where sellable excludes curing, with-contractor and in-transit stock.

| Case | Result |
|---|---|
| Reserve 35 of 100 | onHand 100, reserved 35, available 65 |
| Release (order cancelled) | available returns to 100, no ledger movement |
| Partial — order 100 against 30 | reserves 30, books 70 as production required |
| Curing stock | never reserved; available 0 while curing 50 |
| Insufficient stock at dispatch | refused with "Insufficient stock", balance unchanged |
| Two concurrent confirmations | total active holds never exceed physical stock |

`ReservationService.reserve` takes `FOR UPDATE` on the candidate lots *before* reading existing holds, and subtracts holds **per lot** rather than in aggregate — which is the detail that stops the same physical units being promised twice.

---

## 7. Negative stock and concurrency

**PASS.** Business rule: negative stock is blocked by default and permitted per factory via `Factory.allowNegativeStock` (BR-04).

- **Blocked** where not allowed: dispatching 50 against 10 on hand is refused; the ledger and every lot balance are unchanged afterwards.
- **Permitted and flagged** where explicitly configured: the movement posts, the balance goes to −3, and the entry carries `isNegativeStockEvent = true` with a logged warning.
- **Enforced in the backend**, in `postEntry`, under the lot lock — not in the UI.

### The brief's scenario, executed

> User A sells 100, User B sells 100, available = 150. Stock must not become −50.

Two dispatches fired genuinely in parallel against 150 units. **Exactly one succeeded.** Final ledger net: **50**. Lot balances: **50**. Never negative, and the recorded quantity equals the stock that actually moved.

---

## 8. Database

| Aspect | Finding |
|---|---|
| Atomic updates | `postEntry` requires a transaction and takes `SELECT … FOR UPDATE` on the lot before reading or writing. `consumeFifo` locks its whole candidate set. |
| Transaction IDs | Every entry carries `referenceType` + `referenceId` back to the document that caused it, and `reversalOfEntryId` for corrections. |
| Product / location keys | `(tenantId, factoryId, productId)` on both lots and entries; `RESTRICT` foreign keys throughout. |
| Organization isolation | `tenantId NOT NULL` with CLS-injected scoping on finders, counts and — since the sales audit — aggregates. |
| Indexes | `rpt_stock_ledger_tenant_factory_product_date`, `rpt_stock_ledger_tenant_movement_type`, `rpt_stock_lots_tenant_factory_origin` already existed. Four added for adjustments: unique on `(tenantId, adjustmentNumber)`, plus `(tenantId, factoryId, adjustmentDate)`, `(tenantId, productId)`, `(tenantId, lotId)`. |
| Race conditions | None found. The only unlocked reads are reporting paths, where a snapshot is the correct semantic. |
| Append-only ledger | `stock_ledger_entries.updatedAt` is nullable and nothing updates a posted entry except to attach `reversalOfEntryId`. |

---

## 9. Not implemented — reported instead

### 9.1 Adjustment approval workflow — **P2**

An adjustment posts immediately. In a tighter control environment a write-off beyond a threshold would queue for supervisor sign-off, the way `PRODUCTION_APPROVE_VARIANCE` already gates production variance. The machinery exists (a named grant, a pending state, an approver) but wiring it needs a business answer: what threshold, whose approval, and whether stock moves before or after it. Building it on a guess would put a control in place that nobody had specified.

### 9.2 Stock count session / cycle counting — **P2**

Adjustments are per lot. A full physical inventory is a *session*: freeze, count everything, review the variances together, then post. Doing that properly means a count-sheet entity and a posting step, which is a feature, not a repair — but it is the natural next step now that the single-lot correction exists.

### 9.3 UOM conversion on receipt — **P2**

Carried forward from the purchase audit: a goods receipt takes a quantity with no unit and assumes the product's stocking unit. `UomService.convert` exists and is already used by the BOM explode, so the machinery is there.

### 9.4 Inventory valuation — **P2**

Stock is tracked in quantity only. Value is computed on the fly as `qtyAvailable × product.standardCostPaise` in the dashboard, analytics and ageing services. There is no moving-average or FIFO cost layer, so the reported stock value moves retroactively whenever a product's standard cost is edited. Correct for a standard-costing system, and consistent with the purchase side expensing to `PURCHASE_EXPENSE` rather than an inventory asset — but it should be a deliberate choice, not a discovery.

---

## 10. Reporting

All eight reports the brief names, served and reconciling:

| Report | Path | Result |
|---|---|---|
| Current Stock | `inventory/current-stock` | **PASS** — `Opening + IN − OUT = Closing`, and Closing equals the ledger net |
| Stock Movement | `inventory/movement` | **PASS** — every movement present; `Σ(In − Out)` equals the ledger net |
| Stock Transfer | `inventory/transfers` | **PASS** |
| Stock Adjustment | `inventory/adjustments` | **PASS** — now populated by real adjustments, not just the migration importer |
| Stock Reconciliation | `inventory/reconciliation` | **PASS** — zero drift across every lot |
| Stock Ageing | `ageing/stock-ageing` | **PASS** |
| Slow Moving | `ageing/slow-moving` | **PASS** |
| Dead Stock | `ageing/dead-stock` | **PASS** |

Location scoping verified on reports too: a Plant-B user asking for Plant A explicitly gets 403; asking unfiltered gets a payload containing no Plant A data.

---

## 11. Reconciliation — the proof

One product driven through **every** mutation type, with the expected balance tracked by hand at each step and checked against both the movement ledger and the derived lot balances:

```
  purchase                            expected    500  ledger    500  balances    500
  second purchase                     expected    700  ledger    700  balances    700
  purchase return                     expected    650  ledger    650  balances    650
  production consumption              expected    450  ledger    450  balances    450
  production output (FG)              expected    100  ledger    100  balances    100
  transfer out                        expected    350  ledger    350  balances    350
  transfer received (source unchanged) expected   350  ledger    350  balances    350
  reservation (no movement)           expected    100  ledger    100  balances    100
  sale                                expected     60  ledger     60  balances     60
  sales return                        expected     70  ledger     70  balances     70
  adjustment                          expected    343  ledger    343  balances    343
  receipt before cancel               expected    403  ledger    403  balances    403
  receipt cancelled                   expected    343  ledger    343  balances    343
```

And at the end, system-wide:

- `reconcileLedgerVsBalances()` → **zero discrepancies** across every lot.
- `rebuildStockBalances()` → **every balance unchanged**, i.e. the projection is fully reproducible from the immutable ledger.
- Raw material conserved across both locations: `500 + 200 − 50 − 200 − 7 = 443` units still accounted for somewhere, nothing created or destroyed by the transfer.
- The Stock Reconciliation report agrees, `mismatchCount = 0`.

**This is the basis for the PASS verdicts above.**

---

## 12. Files changed

**Backend — new (5):** `src/migrations/20260831000000-stock-adjustments.js`, `src/api/inventory/stockAdjustment.model.js`, `src/api/inventory/stockAdjustment.service.js`, `tests/inventory-audit.test.js` (33 assertions), `tests/inventory-reconciliation.test.js` (11 assertions).

**Backend — modified (4):** `inventory.controller.js` (location scoping on lots/ledger/balance, full balance breakdown, adjustment endpoints), `inventory.router.js`, `inventory.schema.js`, `stockLedger.service.js` (scoped and sortable lists; `search` now actually applied), `models/index.js`.

**Frontend — new (1) / modified (2):** `components/inventory/stock-adjustment-dialog.jsx` (count-based, live difference, mandatory reason), `pages/InventoryPage.jsx` (Adjustments tab, Adjust action, RBAC gating, server sorting, error surfacing, empty states), `hooks/use-inventory.js`.

---

## 13. Tests

| Run | Suites | Tests | Result |
|---|---|---|---|
| Baseline (before this audit) | 28 passed, 2 failed | 387 passed, 2 failed | The 2 are pre-existing date-sensitive curing tests. |
| Inventory audit suite, **before** fixes | — | **22 passed / 11 failed** | 7 of the 11 were the missing adjustment operation. |
| Inventory audit suite, **after** fixes | — | **33 / 33 passed** | |
| Inventory reconciliation | — | **11 / 11 passed** | |
| **Final full suite** | **30 passed, 2 failed** | **431 passed, 2 failed** | Same 2 pre-existing failures. **No regressions.** |

Frontend: `vite build` clean; `eslint src` 0 errors.

### Not verified

- Browser-rendered UI (build, lint and code trace only).
- Load at production volume — the reconciliation walks every lot in a loop, which is correct for a nightly job but has not been measured against millions of rows.
- Concurrency beyond two simultaneous actors.
- Lot-level FIFO *costing* — FIFO **selection** is verified; there is no cost layer to test (§9.4).

---

## Summary

Unusually for these audits, the thing being examined was largely right. The ledger/balance separation, the single-writer discipline, the mandatory transactions and the lot-level locking are the reason four consecutive audits across masters, sales, purchasing and inventory found **no double-deduction, no oversell and no lost stock anywhere** — including under deliberately concurrent load.

What it could not do was record a physical count. Adjustment movement types, report filters and a whole Stock Adjustments report existed with nothing behind them, so the one correction a warehouse actually needs — the system says 100, the shelf says 92 — was impossible. Alongside it, stock was readable across every location regardless of assignment, and the balance endpoint reported a curing warehouse as empty.

11 of 33 audit assertions failed at the start; all 33 pass now, alongside an 11-step reconciliation that drives one product through every mutation type and demonstrates at each step that the hand-computed expectation, the movement ledger and the derived balances agree. The full suite went from 387 to 431 passing with no regressions.

Four things are documented and deliberately not built: **adjustment approval**, **cycle-count sessions**, **UOM conversion on receipt**, and **inventory valuation layers** — the last being a standing design choice worth making explicitly rather than discovering.
