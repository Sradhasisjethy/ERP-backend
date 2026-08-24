# Finance & Accounts — Audit

**Date:** 2026-08-19
**Scope:** the general ledger, customer and vendor accounting, payments, expenses, cash flow, financial security and the eight finance reports.
**Method:** every posting path traced to source, then executed. The reconciliation in §9 is the basis for every PASS — the brief says not to declare PASS if ledger and transaction data cannot be reconciled, so §9 is that reconciliation.

**Stack:** PostgreSQL + Sequelize.

---

## 1. Verdict

**The double-entry core is correct.** `LedgerService.postJournal` is the single posting path for all ten modules that touch money, and it enforces the things that actually matter: it refuses an unbalanced journal outright, it requires a party on every control-account line, it checks BR-21's cash floor before crediting cash, and a correction is always a new opposite entry that never edits the original. Verified by execution across a full trading period:

- every journal entry balances internally,
- total debits equal total credits across the whole system,
- the trial balance sums to zero,
- **no document has more than one journal** — no duplicated ledger effects anywhere,
- every control-account line carries a party.

That part needed no repair. What was wrong was everything built *on top* of the ledger — the way the numbers were read back out.

**Four defects, all in presentation and access rather than posting:** vendor statements reported the wrong sign, party statements had no running balance at all, the cash book both understated multi-tender days and started every windowed report from zero, and none of the ledger endpoints were location-scoped.

---

## 2. Flow trace

| Flow | Posting | Status |
|---|---|---|
| Sales → Invoice → Receivable | `Dr ACCOUNTS_RECEIVABLE / Cr SALES_REVENUE + GST_OUTPUT_* ± ROUND_OFF` | **PASS** |
| → Customer Payment | `Cr ACCOUNTS_RECEIVABLE / Dr CASH\|BANK` | **PASS** |
| → Customer Ledger | statement + outstanding | **was PARTIAL → now PASS** |
| Purchase → Payable | `Dr PURCHASE_EXPENSE / Cr ACCOUNTS_PAYABLE` | **PASS** (this posting was added in the purchase audit — it did not exist) |
| → Vendor Payment | `Dr ACCOUNTS_PAYABLE / Cr CASH\|BANK` | **PASS** |
| → Vendor Ledger | statement + outstanding | **was FAIL → now PASS** |
| Expenses → Cash/Bank | `Dr FACTORY_EXPENSE / Cr CASH\|BANK` | **PASS** |
| Returns / credit + debit notes | `Dr/Cr` the party control account against `SALES_RETURN` / `PURCHASE_RETURN` | **PASS** |
| Workforce accruals + advances | `Cr/Dr ACCOUNTS_PAYABLE` against the wage/job-work accounts | **PASS** |
| Cheque bounce | reverses the original receipt journal | **PASS** |
| Opening balances | against `OPENING_BALANCE_EQUITY` | **PASS** |
| All → Day Book → Cash Flow → Reports | | **was PARTIAL → now PASS** |

---

## 3. Defects found

| # | Defect | Severity | Status |
|---|---|---|---|
| **A1** | **Vendor, contractor and labour statements reported outstanding with the wrong sign.** `getPartyOutstanding` applied `debit − credit` to every party type. That is right for a customer, whose invoice debits the receivable — and it returns the **negation** for a payable party, whose liability credits when they earn. So a vendor we owed ₹20,000 read **−20,000** on the statement while the payables report read **+20,000**. Two conventions for the same number in one system. | **P1** | **FIXED** |
| **A2** | **Party statements had no running balance at all.** The endpoint returned raw journal lines, newest-first, with no balance column, no opening figure and no closing figure. A statement without a running balance is not a statement — and a running balance computed over a descending, paginated list would have been meaningless anyway. | **P1** | **FIXED** — oldest-first, with a real opening balance carried into each page. |
| **A3** | **The cash book counted one cash line per journal.** It read `entry.lines[0]`. A receipt taken as two cash tenders posts two cash lines on the same journal, so the second was silently dropped — ₹500 received as ₹300 + ₹200 appeared in the cash book as ₹300, with no error anywhere. | **P1** | **FIXED** — every line touching the account is summed. |
| **A4** | **The cash book's running balance started at zero however it was filtered.** Asking for September opened at nil rather than at the balance on 1 September, so `opening + in − out = closing` — the identity the brief asks to verify — was wrong by everything that happened before the window. | **P1** | **FIXED** — a real opening balance as at `from`. |
| **A5** | **No location scoping on any ledger endpoint.** `/trial-balance`, `/cash-book` and `/party/:id` took `factoryId` as an optional filter and applied no restriction when it was omitted, so any user with `LEDGER_READ` could pull the whole tenant's books regardless of which plant they were assigned to. The same gap found and fixed in sales, purchasing and inventory. | **P0** | **FIXED** |
| **A6** | **The running balance and opening/closing figures were unmasked money.** Adding them created new BR-27 surface; they are money and must not reach a browser without `VIEW_RATES`. | **P1** | **FIXED** — masked with the rest. |

### What was *not* wrong — verified, not assumed

| Checked | Result |
|---|---|
| Unbalanced journal accepted | **No** — `postJournal` throws, so nothing commits. Tested directly. |
| Duplicate ledger entries | **None.** Every non-reversal entry is unique per `(referenceType, referenceId)`. |
| Control-account line without a party | **None** — refused at post time. |
| Trial balance out | **Balances to zero.** |
| Reversal edits the original | **Never.** A reversal is a new entry carrying `reversalOfEntryId`. |
| BR-21 cash floor | **Enforced** — a cash expense with no cash is refused, verified. |
| Partial / multiple / over-payment | **Correct** — over-allocation refused with the outstanding named. |
| **Money returned to users who cannot see it** | **Reports: already correct.** The report runner filters money *columns* by `VIEW_RATES` **and** deletes the keys from every row and from the summary (`deniedColumnKeys`). The brief's specific question — "are frontend-hidden financial fields still returned from the backend?" — is **no**, for reports. The ledger endpoints needed the new fields added to their masking (A6). |

---

## 4. The party statement sign

Worth its own section, because it is the one place I changed behaviour that four other test suites depended on.

`ACCOUNTS_RECEIVABLE` and `ACCOUNTS_PAYABLE` are mirror accounts. A customer's invoice **debits** the receivable and their receipt **credits** it, so what they owe is `debit − credit`. A vendor's bill **credits** the payable and the payment **debits** it, so what we owe them is `credit − debit`. Applying one expression to both returns the payable negated.

The reports module has always had this right, and says so:

> *"Reporting both as a bare debit−credit would show every payable as a negative number, which is not how anyone reads a statement."*

The ledger endpoint did not. I found this during the **purchase** audit, implemented the fix, saw it break four tests across the returns, workforce, contractor and labour suites — each asserting the negative-balance behaviour deliberately, with explanatory comments — and **reverted it**, on the grounds that flipping a shared finance convention four modules depend on was not a call to make inside a purchase audit. It was written up there for a decision.

Finance *is* that decision, and this audit is its proper scope. So it is now fixed, and those four assertions are updated with the reasoning recorded at each one. The convention across the whole system is now single: **positive means money is outstanding, whichever direction it flows.**

Verified end to end in §9: the vendor statement and the payable control account agree in magnitude and are exact negatives of each other by construction, which is the property that makes the two views reconcilable rather than merely similar.

---

## 5. Customer and vendor accounting

| Case | Result |
|---|---|
| Invoice raises a balanced receivable against the customer | **PASS** |
| Partial payment | **PASS** — receivable reduces by exactly the allocation |
| Multiple payments settling in full | **PASS** — receivable returns to nil |
| Overpayment | **Refused**, naming the outstanding balance |
| Reversal (receipt cancelled) | **PASS** — a new opposite entry; the receivable comes back |
| Cancellation of a paid invoice | **Refused** (fixed in the sales audit) |
| Vendor bill raises a payable | **PASS** |
| Vendor partial payment, `paymentStatus` derived | **PASS** |
| Vendor outstanding reads positive | **PASS** (A1) |
| Statement running balance | **PASS** (A2) |

---

## 6. Payments and expenses

**Payments — PASS.** Multi-mode receipts record each mode with its own reference; the modes must sum to the total or the receipt is refused; the unallocated remainder is tracked on the document; allocation cannot exceed the receipt, the invoice's outstanding balance, or cross to another party's invoice (the last two fixed in the sales and purchase audits); cancellation reverses the journal and releases the invoice for re-allocation.

**Expenses — PASS.** Category, amount and mode are recorded; the posting debits `FACTORY_EXPENSE` and credits `CASH` or `BANK` according to the mode; BR-21 refuses a cash expense the factory has no cash for; cancellation reverses it. Verified against the account balances directly, not just the response body.

*Expense category remains free text* — carried forward from the Master Data audit (§3.4 there) as the highest-value of the deferred masters, precisely because it degrades the expense-by-category report.

---

## 7. Security

| Finding | Status |
|---|---|
| Location isolation absent on all three ledger endpoints (A5) | **FIXED** — an explicit `factoryId` the caller cannot access is refused; no filter restricts to their own factories rather than returning the tenant's whole books. Verified: a Plant-B user's trial balance shows Plant B's cash and not Plant A's. |
| Tenant isolation | **PASS** — another tenant's party statement returns no rows and their trial balance still sums to zero. |
| RBAC (`LEDGER_READ`) | **PASS** — a user without it gets 403 on the trial balance and on any party statement; unauthenticated gets 401. |
| BR-27 money masking on ledger endpoints | **FIXED for the new fields** — trial balance, cash book (rows, opening, closing, totals) and party statement (rows, running balance, outstanding, opening, closing) all return `null` without `VIEW_RATES`. |
| BR-27 masking on receipts, payments, expenses | **PASS** |
| BR-27 masking in reports | **PASS, already correct** — money columns are dropped from the definition **and** the keys deleted from every row and the summary. |

---

## 8. Audit trail

**PASS.** Every financial document (`SalesInvoice`, `Receipt`, `PurchaseInvoice`, `Payment`, `Expense`) is on `audit_logs` with a user, a timestamp, an entity id, and — for updates — before and after snapshots. Verified specifically that a receipt cancellation records `beforeSnapshot.status = 'POSTED'` and `afterSnapshot.status = 'CANCELLED'` with a captured IP address. Journal entries additionally carry `createdBy`, `entryDate`, `factoryId` and the `referenceType`/`referenceId` of the document that caused them.

---

## 9. Reconciliation — the proof

A full trading period: buy 1,000 units of raw material and book the bill; sell 100 finished units and invoice them; take the customer's money in two parts; return material to the vendor and pay the bill; pay two expenses. Then:

| Check | Result |
|---|---|
| Every journal entry balances internally | **PASS** |
| Total debits = total credits, system-wide | **PASS** |
| Trial balance sums to zero | **PASS** |
| Customer control account (`1100`) = customer statement closing balance = **0** | **PASS** |
| Vendor control account (`2000`) = **+4,00,000** (a debit, because the return exceeded what remained owing) and the vendor statement reads **−4,00,000** outstanding — exact negatives, correctly signed for a payable | **PASS** |
| Every statement row's running balance = previous + that row's movement | **PASS** |
| `opening + in − out = closing` on the bank book, whole period | **PASS** |
| Same identity on a **mid-period window**, whose closing figure matches the full-period closing figure | **PASS** |
| Day Book debits = credits | **PASS** |
| Expense report total = `FACTORY_EXPENSE` account balance | **PASS** |

**This is the basis for the PASS verdicts above.**

---

## 10. Reports

All eight the brief names, served and reconciling:

| Report | Path | Result |
|---|---|---|
| Customer Ledger | `customer/ledger` | **PASS** |
| Vendor Ledger | `vendor/ledger` | **PASS** |
| Receivables | `finance/receivables` | **PASS** |
| Payables | `finance/payables` | **PASS** |
| Payment Report | `payment/register` | **PASS** |
| Expense Report | `expense/register` | **PASS** — total ties to the expense account |
| Day Book | `finance/day-book` | **PASS** — debits equal credits |
| Cash Flow | `finance/cash-flow` | **PASS** |

---

## 11. Not implemented — reported instead

### 11.1 Manual journal entry — **P2**

`postJournal` is only reachable through a business document. There is no way to post an adjusting entry, a depreciation charge, a year-end accrual or a correction that has no document behind it. That is a defensible design — it makes every ledger line traceable to a transaction, which is why the "no duplicate journals" and "every control line has a party" checks pass so cleanly — but a real finance team eventually needs one, with its own permission and an approval step. Building it means deciding who may post one and whether it needs sign-off, which is a control decision, not a code decision.

### 11.2 Period close / lock — **P2**

Nothing prevents posting into a financial year that has been reported on. `FinancialYear` exists with `isCurrent`, but no posting path checks it, so a backdated entry can land in a closed period and silently change a filed figure. This is the most valuable of the deferred items.

### 11.3 Bank reconciliation — **P2**

The cheque lifecycle tracks issued → presented → cleared → bounced, but there is no statement-import or match-off against a bank statement, so the book balance is never proved against the bank's.

### 11.4 Multi-currency — **N/A**

Everything is integer paise, single currency. Correct for the stated scope; noted because it is a structural assumption rather than an omission.

### 11.5 Expense category master — **P2**

Carried forward from the Master Data audit.

---

## 12. Files changed

**Backend — modified (5):** `ledger.service.js` (party statement with running balance and opening/closing; payable-aware outstanding; cash book summing all account lines with a real opening balance; trial balance factory-scoped), `ledger.controller.js` (location scoping, masking of every money field including the new ones), `tests/ledger.test.js`, `tests/returns.test.js`, `tests/workforce.test.js` (updated to the corrected sign convention, each with the reasoning recorded at the assertion).

**Backend — new (2):** `tests/finance-accounts-audit.test.js` (30 assertions), `tests/finance-reconciliation.test.js` (8 assertions).

No frontend changes were needed: the finance screens read the same endpoints and gained the running balance and opening/closing figures automatically. No migration was needed — every defect was in how the ledger was read, not how it is stored.

---

## 13. Tests

| Run | Suites | Tests | Result |
|---|---|---|---|
| Baseline (before this audit) | 30 passed, 2 failed | 431 passed, 2 failed | The 2 are pre-existing date-sensitive curing tests. |
| Finance audit suite, **before** fixes | — | **23 passed / 7 failed** | |
| Finance audit suite, **after** fixes | — | **30 / 30 passed** | |
| Finance reconciliation | — | **8 / 8 passed** | |
| **Final full suite** | **32 passed, 2 failed** | **469 passed, 2 failed** | Same 2 pre-existing failures. **No regressions.** |

Frontend: `vite build` clean; `eslint src` 0 errors.

### Not verified

- Browser-rendered UI.
- Load at production volume — the party statement's opening balance re-reads every prior line, which is correct but linear in statement length.
- Concurrency beyond two simultaneous actors (covered in the sales and purchase audits, where the races actually were).
- Statutory correctness of the GST postings against a filed return — the split and the accounts are right; whether the rates match the department's expectations is a tax question, not a code one.

---

## Summary

The ledger itself was sound. `postJournal` refuses an unbalanced entry, demands a party on every control-account line, enforces the cash floor, and never edits history — and across a full trading period every entry balanced, the trial balance summed to zero, and no document had produced a duplicate journal.

Everything wrong was in reading the numbers back. Vendor, contractor and labour statements reported what we owed as a **negative** balance while the payables report reported the same figure positive — two conventions for one number. Party statements had no running balance at all. The cash book counted one cash line per journal, so a receipt split across two tenders was silently understated, and its running balance restarted at zero however the window was filtered, breaking `opening + in − out = closing` for every dated report. And any user with `LEDGER_READ` could pull the whole tenant's books regardless of which plant they worked at.

7 of 30 audit assertions failed at the start; all 30 pass now, alongside an 8-step reconciliation that runs a full trading period and proves the books balance, each control account ties to its parties' statements, the cash identity holds on both a full period and a mid-period window, and the reports agree with the journal underneath them. The full suite went from 431 to 469 passing with no regressions.

The one behavioural change worth flagging: I fixed the statement sign that I had found and deliberately **reverted** during the purchase audit, because it changes what four other modules mean by "outstanding". Finance is the right scope for that decision, so it is made here, and the four affected assertions are updated with the reasoning recorded at each.

Five things are documented and not built — **manual journal entry**, **period close/lock**, **bank reconciliation**, **multi-currency** and the **expense category master**. Period close is the one I would do next: nothing currently stops a backdated entry landing in a period that has already been reported on.
