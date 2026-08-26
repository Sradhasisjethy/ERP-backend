# Purchase Management — Audit and Production Hardening

**Date:** 2026-08-19
**Scope:** M11 Indents, M12 Purchase Orders / Goods Receipts / Purchase Invoices, and their integration with Inventory, the General Ledger, Payments, Reports and the Audit Log.
**Method:** every claim traced UI → hook → API → route → middleware → controller → service → model → migration → SQL, then executed. Nothing is marked PASS from reading code.

**Stack:** PostgreSQL + Sequelize (not MongoDB, as the earlier briefs stated).

---

## 1. Headline

The purchase module moved stock correctly and **never touched the books.**

`PurchasingService.createPurchaseInvoice` was a bare `PurchaseInvoice.create(data)` — no validation, and no journal entry. `ACCOUNTS_PAYABLE` was never credited by a purchase. Meanwhile the *payment* against that invoice debits it, and a *purchase return* debits it too. So a vendor who had been billed and paid finished with a **negative payable**: the books said the vendor owed us money. `PURCHASE_EXPENSE` (5000) and `GST_INPUT` (1200) sat in the chart of accounts with nothing ever posting to them, while `PURCHASE_RETURN` (5050) was posted correctly — the contra account worked and the account it was contra to did not.

Proven by execution, not inference: `JournalEntry.findOne({ referenceType: 'PurchaseInvoice' })` returned `null`.

---

## 2. The flow, traced

| Step | Verified by | Before | After |
|---|---|---|---|
| Vendor | type + active guard at PO and GRN | PASS | **PASS** |
| Purchase Order | create / view / **edit** / confirm / cancel | PARTIAL | **PASS** |
| Approval | indent raised → approved by a different grant → converted | PASS | **PASS** |
| Goods Receipt | posts stock, tracks `receivedQty`, partial receipt | PARTIAL | **PASS** |
| Inventory IN | exactly one `PURCHASE_IN` per receipt, correct factory | PASS | **PASS** |
| **Purchase Invoice** | **journal entry, balanced, against the vendor** | **FAIL** | **PASS** |
| **Vendor Payable** | `ACCOUNTS_PAYABLE` credit | **FAIL** | **PASS** |
| Payment | partial / full / over-allocation / status | PARTIAL | **PASS** |
| Vendor Ledger | rows + balance | PARTIAL | **PASS** (sign caveat — §7) |
| Reports | 7 report paths | PARTIAL | **PASS** |
| Audit Log | every document, attributed | PASS | **PASS** |

---

## 3. Capability matrix

| Capability | Before | After | Note |
|---|---|---|---|
| Create (PO / GRN / Invoice) | ✅ | ✅ | |
| View | ✅ | ✅ | |
| **Edit** | ❌ | ✅ | No `PUT /purchasing/orders/:id` existed. A draft PO with a wrong quantity had to be cancelled and re-keyed, burning a PO number. Added, DRAFT-only. |
| **Cancel — PO** | ✅ | ✅ | |
| **Cancel — Goods Receipt** | ❌ | ✅ | `GoodsReceipt.status` carried a `CANCELLED` value and a `cancelReason` column **since the table was created**, with no service method, controller or route to reach them. A receipt entered against the wrong product or quantity was permanent. |
| **Cancel — Purchase Invoice** | ❌ | ✅ | The model had no status column at all. Combined with the above, the purchase side had **no correction path whatsoever**. |
| Approval | ✅ | ✅ | Indent approval is a separate grant from creation (verified: the raiser gets 403 on their own indent). |
| Search | ⚠️ | ✅ | PO search matched the PO number only — never the vendor, which is what buyers actually search by. |
| Sorting | ❌ | ✅ | Accepted `sortBy`/`sortDir` and ignored them; order was hardcoded. Now allow-listed and server-side. |
| Pagination | ✅ | ✅ | |
| Vendor validation | ✅ | ✅ | Added in the Master Data audit. |
| Product validation | ⚠️ | ✅ | Existence + active existed; duplicate lines did not. |
| Quantity / Rate | ✅ | ✅ | |
| **Discount** | ❌ | ❌ | Not present anywhere — see §6.1. |
| **Tax** | ❌ | ❌ | No breakdown on the invoice; ITC is derived from HSN at report time — §6.2. |
| **Location** | ❌ | ✅ | No factory scoping on orders, receipts, invoices or indents — §5. |
| **Payment status** | ⚠️ | ✅ | Was directly settable — §4 P6. |
| Organization | ✅ | ✅ | Verified cross-tenant. |

---

## 4. Defects found

| # | Defect | Severity | Status |
|---|---|---|---|
| **P1** | **Purchase invoices posted no journal entry.** Vendor payables never reached the ledger, the trial balance, the payables report or the vendor statement. Payments and purchase returns then *debited* an account nothing had credited, driving vendor balances negative. | **P0** | **FIXED** — posts `Dr PURCHASE_EXPENSE / Cr ACCOUNTS_PAYABLE`, mirroring the purchase-return entry that already existed. |
| **P2** | **No location scoping anywhere in purchasing.** A user assigned only to Plant B could list and open every Plant A order, receipt and invoice, and could **raise purchases against Plant A** by naming its id. BR-29 was enforced on dashboards and reports and nowhere else — the same gap found and fixed on the sales side. | **P0** | **FIXED** |
| **P3** | **A second invoice could be raised against the same goods receipt**, doubling the vendor payable — and doubling the **input tax credit** claimed on GSTR-3B, since ITC is derived by walking the GRN lines behind each purchase invoice. | **P0** | **FIXED** — service check plus a partial unique index. |
| **P4** | **A goods receipt could never be cancelled** (see §3). Stock stayed overstated permanently; the only workaround was a fake stock adjustment that misattributed the correction. | **P1** | **FIXED** — reverses the ledger entries, winds back `receivedQty`, keeps the document and its number (BR-33). Refused if the material has already been consumed or invoiced, because then the correct instrument is a purchase return. |
| **P5** | **A purchase invoice could never be cancelled.** | **P1** | **FIXED** — status column added, journal reversed, refused once any payment is allocated. |
| **P6** | **Payment status was directly settable.** `PUT /invoices/:id/payment-status` (and a dropdown on the Invoices tab) let anyone with `PURCHASE_MODIFY` mark an unpaid bill **PAID** — zeroing a payable with no money behind it, while the ledger still carried it. Two writers of the same field, one of them unchecked. | **P1** | **FIXED** — endpoint and dropdown removed; the field is derived from allocations only. |
| **P7** | **No cap on over-receipt.** A goods receipt could take in any quantity against a purchase order line, inflating both stock and the payable, with nothing for the three-way match to flag it against. | **P1** | **FIXED** — 20% tolerance, mirroring the dispatch side. |
| **P8** | **Concurrent receipts lost updates.** Two receipts against one order both read the same `receivedQty` and both added their own — 70 + 70 against a 100-unit order booked 140 units of stock while the line recorded 70. | **P1** | **FIXED** — `FOR UPDATE` on the order row. |
| **P9** | **The invoice never checked its goods receipt.** Vendor, factory and cancellation status were all unvalidated, so a bill could be booked against another vendor's receipt, at another location, or against a receipt that had been reversed. | **P1** | **FIXED** |
| **P10** | **Duplicate product lines on one purchase order** — the same requirement ordered, received and invoiced twice with neither line looking wrong. | **P1** | **FIXED** |
| **P11** | **Cancelled bills would still have counted as payables.** Once cancellation existed, the purchase summary, purchase by-vendor, vendor summary, vendor outstanding and the analytics purchase totals all had to exclude them — sales invoices were already filtered to `POSTED` everywhere; purchase invoices had no status to filter on. | **P1** | **FIXED** — filter added at all five sites. |
| **P12** | **GSTR-3B claimed input tax credit on cancelled bills.** The ITC block's own comment said "billed via a POSTED purchase invoice" — an intent the code could not honour, because there was no status column. | **P1** | **FIXED** — the code now matches its comment. |
| **P13** | Converting an indent returned a purchase order with **no lines**, so the screen that converts had nothing to show or receive against without a second round trip. | **P2** | **FIXED** |

---

## 5. Security

| Finding | Severity | Status |
|---|---|---|
| Location isolation absent across orders, receipts, invoices and indents (P2 above). Verified fixed for list, read and create on all four. | **P0** | **FIXED** |
| Organization (tenant) isolation | — | **PASS** — verified, no defect |
| RBAC on every purchase write, by direct API call | — | **PASS** — verified, no defect |
| Approval separated from creation (`PURCHASE_APPROVE`) | — | **PASS** — the raiser gets 403 on their own indent |
| Unauthenticated access | — | **PASS** — 401 |
| BR-27 money masking on POs, receipts and invoices | — | **PASS** — verified server-side |

Reversing a posted receipt or a booked payable is gated on `PURCHASE_DELETE`, not `PURCHASE_MODIFY`: both unwind stock or the ledger, which is a different act from editing a draft.

Cross-location reads return **404**, not 403 — a user who may not see Plant A should not be able to confirm which document ids exist there. Creating *for* a forbidden factory returns 403, because there the caller named the factory explicitly.

---

## 6. Missing functionality — identified, not implemented

### 6.1 Discount — **P1**

No discount field on the purchase order, the goods receipt or the invoice. A negotiated reduction can only be recorded by altering the rate, which destroys the record of the list price. Implementing it means new columns on three tables and a rework of the payable calculation. The purchase reports already declare this as a stated limitation.

### 6.2 Purchase-side tax breakdown and ITC posting — **P1**

The purchase invoice carries a single `amountPaise` with no taxable value, tax rate or tax amount. Consequences: `GST_INPUT` is never posted (the invoice journal books the gross to `PURCHASE_EXPENSE`), and GSTR-3B derives ITC by re-deriving tax from the receipt's HSN lines rather than from the bill the vendor actually raised — so a vendor billing at a different rate than the product's HSN is silently reconciled to the HSN.

I deliberately did **not** invent a tax split inside the new journal entry: back-calculating CGST/SGST from a number that does not contain a tax component would post a `GST_INPUT` figure the GST return would then contradict. Doing this properly means adding taxable/tax columns to the invoice and switching the ITC derivation to read them — a schema and statutory-reporting change that needs a decision, not a side effect of this audit.

### 6.3 UOM conversion on receipt — **P2**

A goods receipt line takes `receivedQty` with no unit — the quantity is assumed to be in the product's stocking unit. Buying in bags and stocking in kilograms requires the buyer to convert by hand. `UomService.convert` already exists and is used by the BOM explode, so the machinery is there; wiring it in means a `uomId` on the receipt line and a conversion at post time.

### 6.4 Vendor ledger sign — **P1, deliberately not changed**

`GET /ledger/party/:id` returns `debit − credit` for **every** party type. That is correct for a customer (receivable) and inverted for a vendor (payable), so the same vendor reads **−20,00,000** on the ledger endpoint and **+20,00,000** on the payables report. The reports module gets this right and says so explicitly ("Reporting both as a bare debit−credit would show every payable as a negative number, which is not how anyone reads a statement").

I changed it, and it broke four tests across the returns, workforce, contractor and labour suites — each of which asserts the negative-balance behaviour **on purpose, with explanatory comments**. So the two conventions are both deliberate and they contradict each other. That is a genuine defect, but flipping a shared finance convention that four other modules depend on is not a call to make unilaterally inside a purchase audit. **Reverted, with the reasoning recorded in the code at `ledger.service.js#getPartyOutstanding`,** and raised here for a decision. The purchase end-to-end test asserts the *magnitude* rather than the sign so it does not bake in either convention.

---

## 7. Inventory integration

Verified by counting ledger entries, not by trusting balances:

- One receipt of 80 → exactly one `PURCHASE_IN` entry, at the receiving factory only; the other plant reads zero.
- Partial receipts of 70 then 50 against a 120 order → exactly two entries totalling 120; the order walks `PARTIALLY_RECEIVED` → `RECEIVED`.
- Cancelling a receipt → exactly one `REVERSAL` against exactly one `PURCHASE_IN`; balance returns to zero; `receivedQty` winds back and the order's status recomputes.
- Cancelling a receipt whose stock has already been transferred out is **refused** — `postEntry` cannot cover the reversing OUT, which is the correct answer.
- Two concurrent receipts of 70 against a 100-unit order → exactly one succeeds; stock in equals the quantity recorded.

**No double-counting was found.** As on the sales side, this is a consequence of `StockLedgerService.postEntry` being the single writer of `qtyAvailable`, refusing to run without a transaction, and locking the lot.

---

## 8. Reports

| Brief's report | Path | Result |
|---|---|---|
| Purchase Summary | `purchase/summary` | **PASS** — contains the vendor and its bill; excludes the cancelled one |
| Purchase Detail | `purchase/detail` | **PASS** |
| Vendor Purchase | `purchase/by-vendor` | **PASS** |
| Product Purchase | `purchase/by-product` | **PASS** |
| Payables | `vendor/outstanding` | **PASS** — cancelled bills excluded |
| Vendor Ledger | `vendor/ledger` | **PASS** |
| Inventory | `inventory/current-stock` | **PASS** — the received product appears |

Location scoping verified: a Plant-B user asking for Plant A explicitly gets 403; asking with no filter gets a payload with no Plant A data in it.

---

## 9. Database

| Change | Reason |
|---|---|
| `purchase_invoices.status` (POSTED/CANCELLED) + `cancelReason` | Gives the invoice a lifecycle — there was none. |
| Partial unique index on `(tenantId, goodsReceiptId) WHERE status='POSTED'` | Database backstop for P3. Partial so a genuinely cancelled bill can be re-raised against its receipt. |
| Partial unique index on `(tenantId, vendorPartyId, vendorInvoiceNumber) WHERE status='POSTED'` | Stops the same vendor bill being entered twice under two different receipts. |
| Index on `(tenantId, status)` | The payables and vendor-ledger reports now filter on it. |

Foreign keys across the purchase chain are `RESTRICT` — history cannot be orphaned. No soft deletion; documents are cancelled and keep their numbers, which is correct for an ERP.

---

## 10. Files changed

**Backend — new (3):** `src/migrations/20260830000000-purchase-invoice-lifecycle.js`, `tests/purchase-management-audit.test.js` (28 assertions), `tests/purchase-management-e2e.test.js` (11 assertions).

**Backend — modified (9):**

| File | Change |
|---|---|
| `purchasing.service.js` | Invoice journal posting; invoice validation + cancellation; goods-receipt cancellation; over-receipt cap; `FOR UPDATE` on the order; PO edit; duplicate-line validation; vendor-name search; allow-listed sorting; location-scoped lists. |
| `purchasing.controller.js` / `.router.js` / `.schema.js` | Location scoping on every endpoint; `PUT /orders/:id`, `PUT /receipts/:id/cancel`, `PUT /invoices/:id/cancel`; **removed** `PUT /invoices/:id/payment-status`. |
| `purchaseInvoice.model.js` | `status`, `cancelReason`. |
| `indent.service.js` | Location-scoped list; convert returns the order with its lines. |
| `gstr.service.js` | ITC excludes cancelled bills (P12). |
| `reports/definitions/purchase.js`, `parties.js`, `analytics.js` | Cancelled bills excluded from purchase, payables and analytics figures (P11). |
| `ledger/ledger.service.js` | Sign inconsistency documented in place (§6.4) — behaviour unchanged. |

**Frontend — modified (3):** `PurchasingPage.jsx` (RBAC gating, sorting, error surfacing, goods-receipt and invoice cancellation, **payment status now a read-only badge instead of an editable dropdown**, empty states), `purchase-order-form-dialog.jsx` (edit mode, duplicate-product check, factory locked on edit), `use-purchasing.js` (`useUpdatePurchaseOrder`, `useCancelGoodsReceipt`, `useCancelPurchaseInvoice`; **removed** `useUpdatePaymentStatus`).

---

## 11. Tests

| Run | Suites | Tests | Result |
|---|---|---|---|
| Baseline (before this audit) | 28 passed, 2 failed | 348 passed, 2 failed | The 2 are pre-existing date-sensitive curing tests. |
| Purchase audit suite, **before** fixes | — | **10 passed / 18 failed** | |
| Purchase audit suite, **after** fixes | — | **28 / 28 passed** | |
| Purchase end-to-end flow | — | **11 / 11 passed** | |
| **Final full suite** | **28 passed, 2 failed** | **387 passed, 2 failed** | Same 2 pre-existing failures. **No regressions.** |

Frontend: `vite build` clean; `eslint src` 0 errors.

**A note on suite stability.** Across repeated full runs the failure count varied (2, 4, 5) while only ever *naming* the same two curing tests. Run in isolation, every suite that intermittently failed passes. This matches the symptom `jest.config.js` already documents — `beforeAll` hooks timing out under load once the suite grew past ~20 files, "failures that move between files run to run and never reproduce in isolation". The six test files added across these audits took the suite from 24 to 30 files, making it more likely. It is pre-existing flakiness amplified, not a regression, but it is now frequent enough to be worth fixing: the per-file truncate-and-reseed is the cost driver.

### Not verified

- Browser-rendered UI (build, lint and code trace only).
- Load at production volume; no `EXPLAIN ANALYZE`.
- Concurrency beyond two simultaneous requests.
- Three-way match against the new over-receipt cap — the match endpoint exists and is unchanged, but its behaviour with a capped receipt was not specifically exercised.

---

## Summary

Purchase moved stock correctly and never posted a rupee. The vendor payable — the entire point of a purchase invoice — was absent from the general ledger, so every payment and every purchase return debited an account nothing had credited, and vendor balances went negative. Alongside it: no location isolation, no way to cancel a receipt or a bill, a duplicate bill could double both the payable and the input tax credit, and an endpoint plus a UI dropdown let anyone mark an unpaid bill PAID.

18 of 28 audit assertions failed at the start; all 28 pass now, plus 11 walking the complete chain from vendor through indent, approval, order, receipt, inventory, bill, payable, payment, ledger, reports and audit log. The full suite went from 348 to 387 passing with no regressions.

Four things are documented and deliberately not built: **discount**, **purchase-side tax breakdown and ITC posting** (both change what the GST return says, so they need a business decision before code), **UOM conversion on receipt**, and the **vendor ledger sign inconsistency** — which I implemented, found it contradicted four other modules' deliberate assertions, and reverted rather than decide it unilaterally.
