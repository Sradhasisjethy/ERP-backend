# Cross-Cutting / Enterprise Features — Audit

**Date:** 2026-08-19
**Scope:** the 27 concerns that have to behave identically in every module — authentication, RBAC, tenancy, location access, numbering, notifications, audit, errors, logging, configuration, jobs, reports, export, health, and deployment.
**Method:** traced to source, then executed. 34 assertions, run against the real API.

---

## 1. Verdict

The cross-cutting layer is well designed and mostly well implemented: one permission catalog generating both route guards and the UI matrix, CLS-injected tenancy applied by model hooks rather than by callers, a single balanced-journal posting path, one shared list contract driving every table, and a report runner that strips money server-side. Those are the decisions that made the previous five audits possible.

**What it lacked was consistency of application.** The same control was enforced in some modules and not others, and two controls were written but silently inert:

- **Disabled employees could sign in.** Nothing checked account status at login, and a 7-day refresh token kept minting access tokens for a week after someone was terminated.
- **Production rate limits were switched off** by a `|| true` left in a boolean expression.
- **Location scoping existed in seven modules and was missing from eight**, so a user assigned to one plant could read another plant's production, wages, returns, GST position and analytics.
- **`BadRequestError` was imported and never defined**, turning two password-reset paths into 500s.
- **LOGIN and role/permission changes left no audit trail**, though BR-30 names them.
- **No business event ever raised a notification** — the whole subsystem was driven by one nightly job.

---

## 2. Findings by area

| # | Area | Status | Note |
|---|---|---|---|
| 1 | Authentication | **was FAIL → PASS** | §3 |
| 2 | Authorization / RBAC | **PASS** | Verified by direct API call; no escalation path found |
| 3 | Organization management | **PASS** | Tenant isolation verified on 13 modules |
| 4 | Location / branch access | **was FAIL → PASS** | §5 — the largest gap |
| 5 | Navigation / menu | **PASS** | Permission-filtered from the served catalog |
| 6 | Notifications | **was PARTIAL → PASS** | §6 |
| 7 | Audit logs | **was PARTIAL → PASS** | §7 |
| 8 | Document numbering | **PASS** | §8 — gap-free under concurrency, location-qualified |
| 9 | File / document management | **NOT IMPLEMENTED** | §10.1 |
| 10 | Global search | **PASS** | `analytics/search` across documents |
| 11 | Shared UI components | **PARTIAL** | §9 |
| 12 | API error handling | **was PARTIAL → PASS** | §4 |
| 13 | Validation | **PASS** | zod at every route, parsed values written back |
| 14 | Logging | **PARTIAL** | §10.4 — no request correlation id |
| 15 | Configuration | **PASS** | zod-validated at boot; process exits on a bad env |
| 16 | Background jobs | **PASS** | Nightly batch, non-overlapping, per-job error isolation |
| 17 | Scheduled tasks | **PARTIAL** | §10.3 — in-process timer, single-replica only |
| 18 | Reports | **PASS** | Audited in full previously |
| 19 | Export | **PASS** | xlsx/csv/pdf, same permissions, row ceiling enforced |
| 20 | Activity history | **PASS** | `audit_logs` with before/after snapshots |
| 21 | Soft delete | **N/A by design** | Documented in the Master Data audit |
| 22 | Data retention | **NOT IMPLEMENTED** | §10.2 |
| 23 | System settings | **PASS** | Per-tenant `TenantSettings` |
| 24 | Health checks | **was FAIL → PASS** | §4 |
| 25 | Monitoring | **PARTIAL** | §10.4 |
| 26 | Backup / recovery | **NOT IMPLEMENTED** | §10.5 |
| 27 | Deployment configuration | **PARTIAL** | §10.6 |

---

## 3. Authentication

| # | Defect | Severity | Status |
|---|---|---|---|
| **A1** | **A disabled employee could log in.** `login()` verified the password and issued tokens without ever looking at account status. | **P0** | **FIXED** |
| **A2** | **`refresh()` never re-checked the user either.** The access token is stateless and lives 15 minutes; the refresh token lives 7 days. So disabling an account did nothing for a week — the one point at which a live session can be cut short was not checking. | **P0** | **FIXED** |
| **A3** | **`BadRequestError` was imported by `auth.service.js` and does not exist in `AppError.js`.** `throw new BadRequestError(...)` raised a TypeError, so requesting a reset for a protected admin account, and submitting a reset with missing fields, both returned **500 Internal Server Error** instead of a 400 with the intended message. | **P1** | **FIXED** |

**The status rule is a deny-list, not an allow-list.** The four states are ACTIVE, ONBOARDING, INACTIVE, TERMINATED, and the model **defaults to ONBOARDING** — an employee being set up must be able to sign in, which is that state's entire purpose. I initially wrote `status === ACTIVE` and it locked out every fixture in the codebase, which was the correct signal that the rule was wrong rather than the fixtures. Only INACTIVE and TERMINATED are refused, and with the same message as a bad password: telling an attacker "that account exists but is disabled" still confirms the account exists.

**Verified working, no change needed:** httpOnly + SameSite=strict cookies; `secure` in production; 15-minute access / 7-day refresh; rejection of missing, malformed, wrongly-signed, expired and **`alg: none`** tokens (the algorithm is pinned to HS256 at verify); logout clears both cookies; forgot-password does not disclose whether an email exists.

---

## 4. Errors, health and operations

| # | Defect | Severity | Status |
|---|---|---|---|
| **B1** | **Production rate limits were disabled by a typo.** `const isDev = NODE_ENV === 'development' \|\| !NODE_ENV \|\| true` — the trailing `\|\| true` made it unconditionally true, so a production deployment with `RATE_LIMIT_ENABLED=true` still got 5000 API calls and **1000 login attempts** per 15 minutes instead of 100 and 10. Brute-force protection was off in the only environment that matters. | **P1** | **FIXED** — `resolveLimits(nodeEnv)`, exported so the limits are asserted directly rather than inferred from behaviour, which is what let this sit. |
| **B2** | **`/health` returned `{status:'ok'}` unconditionally.** An instance whose database connection was gone stayed in the load-balancer rotation and kept accepting requests it could only fail. | **P1** | **FIXED** — `/health` and `/health/ready` verify the database and return **503** when it is unreachable; `/health/live` is a separate liveness probe that touches nothing, because a liveness check that queries the database restarts healthy processes during a database hiccup. |

**Error envelope — PASS.** Every class returns `{ success: false, message }` with the right status: 401 unauthenticated, 403 forbidden, 404 not found, 400 validation, 409 conflict. Verified that no response carries a stack trace, SQL, a Sequelize error name, or a `node_modules` path — including for a malformed UUID, which reaches the driver as a cast error.

One accepted quirk: an unmatched path **under `/api/v1`** returns 401 rather than 404, because three routers are mounted at `/api/v1` itself and their `authenticate` middleware runs before the 404 handler is reached. It fails closed and leaks nothing, so it is documented rather than changed.

---

## 5. Location security — the largest gap

BR-29 location scoping was applied module by module across the previous four audits, which left it enforced in some places and absent in others. **Eight modules still accepted `factoryId` as a plain filter**: expenses, production, returns, workforce, transfers, analytics, GST and notifications. A user assigned to one plant could read another plant's production output, labour wages, returns, GST position and analytics simply by naming its id, and could raise documents against it.

Fixed in two layers, deliberately:

- **`middlewares/factoryScope.js`** — mounted once per router, refuses any request naming a factory the caller cannot use, on a read, a create or a report. It handles a transfer's two locations. A middleware cannot know a service's `where` clause, so it does not attempt to filter lists.
- **`baseWhere` in each list service** — the same pattern already used by sales, purchasing, inventory and finance, so a list with no explicit `factoryId` is restricted to the caller's locations rather than returning the tenant's whole dataset.

Verified: a Plant-B user's expenses, production entries, returns, transfers, attendance and notifications contain no Plant-A rows; creating an expense at Plant A is refused; analytics and GST for Plant A are refused.

---

## 6. Notifications

The subsystem is complete and well built — de-duplication is a unique index on `(tenantId, dedupeKey)`, so two racing job runs produce exactly one notification — and **nothing in any business module ever raised one.** Every notification in the system came from the nightly batch.

Worth being precise about what that means. The `type` column is a fixed enum of **14 operational alert types** (dead stock, overdue receivable, credit-limit breach, negative cash, ledger drift, job failed…). This is an *alerting* system, not a transaction-event feed. The brief's example — "Payment Received → Notification" — describes a feed. I started to add a `PAYMENT_RECEIVED` type, then reverted it: that needs a migration and turns an alerting design into an event feed, which is a product decision, not a repair.

The genuine gap is narrower and sits inside the existing design: **several alert types describe transactional conditions that are detected live, and only the overnight sweep ever raised them.** `CREDIT_LIMIT_BREACH` is the clearest — `SalesService.checkCreditLimit` detects it at order entry, which is the moment a supervisor can still act, and said nothing until the next morning. That is now raised at the point of detection, on both the warning and the blocking path, de-duplicated per customer.

`NotificationsService.raise` also now accepts a `transaction`, so an alert raised by a business service can commit with the document that caused it rather than announcing an event that may roll back.

**One thing that had to be got right, and initially was not.** The first attempt raised the alert from inside `checkCreditLimit`, which runs within the order's transaction. Sequelize's CLS injects that transaction into the notification insert, so a failed insert poisons the whole transaction at the Postgres level: the `.catch()` swallowed the notification error while every later statement failed with *"current transaction is aborted"*, and **order creation returned 500**. The full suite caught it. The alert is now raised after the transaction commits — an alert about a document must never be able to prevent that document from existing.

---

## 7. Audit log

BR-30 lists CREATE, UPDATE, DELETE, APPROVE, CANCEL, **LOGIN**, **ROLE CHANGE**, **PERMISSION CHANGE**, PAYMENT and STOCK ADJUSTMENT. All but three were covered by `BaseAuditedModel`'s hooks.

| # | Defect | Severity | Status |
|---|---|---|---|
| **C1** | **LOGIN was never recorded.** Every other audit row is written by a model hook; signing in creates no row, so it had no trail at all. | **P1** | **FIXED** — written in the auth controller, where the IP lives and before any CLS session exists (login is the one path that runs before `tenantScope`). Never fails the sign-in itself. |
| **C2** | **Role and permission changes were not audited.** `AdGroup` — which *is* the permission set — was on the non-auditing base class, and `role.router.js` never mounted `auditContext`, so any row it did write would have carried a null user. | **P1** | **FIXED** — both. |

Verified: create and update rows carry user, IP, timestamp, entity, entity id and before/after snapshots; a permission change records the old and new arrays; the audit log itself requires `AUDIT_READ` and never crosses tenants.

---

## 8. Document numbering — PASS

Eight concurrent expense creations produced **eight unique, gap-free, consecutive numbers**. Series are keyed `(documentType, factoryId, financialYearId)`; the number carries the factory code (`EXP/PA/0001` vs `EXP/PB/0001`) so two plants cannot collide — the P0 fixed during the sales audit. A cancelled document keeps its number and the next allocation does not reuse it.

---

## 9. Shared frontend

**Well consolidated already:** `DataTable` in 28 pages, `usePaginated` in 22, the shadcn `Dialog` in 45 components, `createResourceHooks` generating CRUD hooks for four modules. There is no duplicated table, pagination or modal implementation.

**The genuine duplication is the loading and error block:** 25 pages carry their own `animate-pulse` skeleton and 18 their own "Failed to load X" panel — visually identical, none shared, several with different copy for the same condition. `ProductsPage` had independently grown a local `LoadingOrError` helper, which is the same idea arrived at twice.

Extracted to `components/query-state.jsx` (`QueryState` + `ActionError`, with a retry affordance the inline copies lacked) and adopted in `ProductsPage`, replacing its local duplicate. **Deliberately not swept across the other 24 pages** — that is mechanical but touches modules otherwise untouched by this audit, and the brief says not to modify business modules unnecessarily. It is a clean follow-up, one screen at a time.

---

## 10. Not implemented — reported

### 10.1 File / document management — **P1**

There is **no file handling anywhere**: no `multer`, no upload route, no storage adapter, no download authorisation. `SalesOrder.poAttachmentPath` is a string column with BR-28 permission gating around a path that nothing can ever write. So the brief's file tests — upload, download, delete, MIME validation, size limits, unauthorised download — have no surface to run against. Building it means choosing a storage backend, an authorisation model for object access, and a virus/MIME policy. That is a module, not a repair.

### 10.2 Data retention — **P2**

Nothing ages out. `audit_logs` and `stock_ledger_entries` grow without bound and both are append-only by design. A retention policy needs a legal answer (how long must audit data be kept?) before it can be a technical one.

### 10.3 Scheduler is single-replica — **P2**

`jobs/scheduler.js` is an in-process timer, and says so in its own comment: it dies with the process and does not coordinate across replicas. Running two instances runs the nightly batch twice. The batch is largely idempotent (notification de-duplication, `promoteEligibleLots`), so the blast radius is small, but a horizontally-scaled deployment needs a real job runner or a leader lock.

### 10.4 Monitoring and correlation — **P2**

Structured winston logging and morgan access logs are in place, but there is **no request correlation id**, so an error in the logs cannot be tied to the request that caused it, and no metrics endpoint. Adding a request id in middleware and threading it into the logger is small and high-value.

### 10.5 Backup / recovery — **NOT IMPLEMENTED, P1 for go-live**

No backup configuration, no restore procedure, no tested recovery path in the repository. This is a deployment concern rather than a code one, but it is the single largest operational risk in the list and nothing in the repo documents it.

### 10.6 Deployment — **PARTIAL**

Verified good: env validated by zod at boot with the process exiting on a bad config (`JWT_SECRET`, `JWT_REFRESH_SECRET`, a 32-character `ENCRYPTION_KEY`, `CORS_ORIGIN` all required); `.env.example` present on both sides; secrets never logged; `helmet` and a CORS allow-list; cookies `secure` in production; migrations rather than `sync` outside development; graceful shutdown on SIGTERM/SIGINT closing the server, the scheduler and the connection pool.

Gaps: **no forced-HTTPS redirect or HSTS** beyond helmet's defaults (fine behind a TLS-terminating proxy, which should be stated); **graceful shutdown has no timeout**, so a hung connection blocks exit indefinitely; **no container or deployment manifest** in the repository.

### 10.7 Performance — observations

68 `findAll` calls without a `limit` across the services. Most are legitimately bounded (a document's own lines, a single lot's reservations). The unbounded ones worth watching are `listAccounts`, `getTrialBalance` and the reconciliation walks — all administrative and small today, all linear in data volume. Reports are already bounded, paginated and export-capped at `REPORT_EXPORT_MAX_ROWS`. React Query de-duplicates in-flight requests, and `usePaginated` debounces search at 300 ms.

---

## 11. Files changed

**Backend — new (2):** `src/middlewares/factoryScope.js`, `tests/cross-cutting-audit.test.js` (34 assertions).

**Backend — modified (10):** `core/AppError.js` (adds the missing `BadRequestError`), `middlewares/rateLimiter.js` (`resolveLimits`), `app.js` (readiness + liveness probes), `api/auth/auth.service.js` (status deny-list on login and refresh), `api/auth/auth.controller.js` (LOGIN audit), `api/roles/role.model.js` + `role.router.js` + `api/users/user.router.js` (role/permission-change auditing), `api/sales/sales.service.js` (credit-breach alert at detection), `api/notifications/notifications.service.js` (transaction-aware `raise`).

**Backend — location scoping (13):** routers and services for expenses, production, returns, workforce, transfer, analytics, gstr, notifications.

**Frontend — new (1) / modified (1):** `components/query-state.jsx`, `pages/ProductsPage.jsx` (local helper replaced by the shared one).

---

## 12. Tests

| Run | Tests | Result |
|---|---|---|
| Baseline (before this audit) | 469 passed, 2 failed | The 2 are pre-existing date-sensitive curing tests. |
| Cross-cutting suite, **before** fixes | **17 passed / 17 failed** | |
| Cross-cutting suite, **after** fixes | **34 / 34 passed** | |
| **Final full suite** | **503 passed, 2 failed** | Same 2 pre-existing failures. **No regressions.** |

### Not verified

- Browser-rendered UI.
- File security — nothing to test against (§10.1).
- Backup and recovery — no configuration exists (§10.5).
- Behaviour under real horizontal scaling (§10.3).
- Load at production volume.

---

## Summary

The cross-cutting layer is architecturally sound; what it lacked was uniform application. Two controls were written and silently inert — production rate limiting was switched off by a `|| true`, and `BadRequestError` was imported without ever being defined, turning password-reset failures into 500s. Two were missing entirely: nothing checked whether an employee was still employed at login, and a 7-day refresh token kept minting access tokens for a week after someone was terminated. Location scoping, applied module by module across four previous audits, was present in seven modules and absent from eight. LOGIN and permission changes — both named in BR-30 — left no trail. And a complete notification subsystem, with de-duplication and a screen, was never called by a single business module.

17 of 34 assertions failed at the start; all 34 pass now.

Two judgement calls worth flagging. I initially wrote the account-status check as `status === ACTIVE` and it locked out every fixture in the codebase — the right reading of that was that my rule was wrong, not the fixtures: the model defaults to ONBOARDING and an employee being set up must be able to sign in. And I started adding a `PAYMENT_RECEIVED` notification type before reverting it — the enum is 14 operational alert types, so that would have converted an alerting system into an event feed via a migration. The real gap was narrower and inside the existing design: alert types that describe live transactional conditions were only ever raised by the overnight batch.

Five things are documented and not built: **file/document management** and **backup/recovery** are the two that matter for go-live, and neither is a repair — one is a module, the other is deployment configuration this repository does not contain.
