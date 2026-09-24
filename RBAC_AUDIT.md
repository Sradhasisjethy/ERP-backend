# RBAC Audit & Implementation

Scope: `ERP/backend` (Node/Express/Sequelize) and `ERP/front` (Vite/React 19).
Both are plain JavaScript — there is no TypeScript in either repo, so the
"type-safe" acceptance criterion is not applicable as written.

---

## A. Existing RBAC assessment

**The backend already had a well-designed RBAC system.** This audit did not
build one; it found where the existing one was not applied, and where it was
applied in a way that could never pass.

What was already right, and was left alone:

| Component | File | Verdict |
|---|---|---|
| Permission catalog | `src/utils/permissionCatalog.js` | Single source of truth. `<RESOURCE>_<ACTION>` plus named grants for non-CRUD acts. Good. |
| Route guard | `src/middlewares/authorize.js` | Correct. Bypass limited to `PLATFORM_ADMIN` / `TENANT_OWNER`. |
| Tenant isolation | `src/core/BaseModel.js` | Structural — `beforeFind`/`beforeCount` hooks inject `tenantId`. Cross-tenant IDOR is prevented by construction. |
| Location (factory) scoping | `src/core/factoryAccess.js`, `salesScope.js` | Real data-scope enforcement. `assertCanSeeRecord` returns 404 not 403, deliberately, so document existence does not leak across plants. |
| Role authoring | `src/api/roles/role.service.js` | `assertGrantable` — you cannot grant what you do not hold. Compares *expanded* sets and checks only additions. Above average. |
| Rate masking | `src/utils/fieldMasking.js` | BR-27 money stripping exists and is wired into 23 of 39 controllers. |
| RBAC tests | `tests/rbac.test.js` | Real HTTP tests via supertest. |

**Route coverage measured, not assumed:** 356 routes across 38 routers. Only 18
lacked `authorize()`, and all 18 were verified as deliberate — auth endpoints,
per-user notifications, and the reports catalog (which checks in-controller
because the required permission depends on *which* report was asked for).

### What was actually wrong

| # | Finding | Severity | Status |
|---|---|---|---|
| 1 | `POST /roles/:id/members` skipped `assertGrantable` — assign yourself to the seeded `*` role, re-login, superuser | **CRITICAL** | **Fixed** |
| 2 | `PUT/POST /users` accepted `role` and `roleId` with no escalation check — `{"role":"PLATFORM_ADMIN"}` on your own record | **CRITICAL** | **Fixed** |
| 3 | Every user-write route guarded on legacy `EMPLOYEE_WRITE`, which no role can hold — user administration was silently superuser-only | **CRITICAL (functional)** | **Fixed** |
| 4 | `/uploads` served by `express.static` with no auth — employee offer letters and ID scans world-readable | **HIGH** | **Fixed** |
| 5 | Employee document upload: no `fileFilter`, no size limit, `req.params.id` joined into a filesystem path | **HIGH** | **Fixed** |
| 6 | Frontend had **no route-level permission guard on any of its 46 authenticated routes** | **HIGH** | **Fixed** |
| 7 | Two competing frontend permission helpers with divergent semantics | **MEDIUM** | **Fixed** |
| 8 | Cmd-K global search listed and navigated to every module regardless of grants | **MEDIUM** | **Fixed** |
| 9 | 403 rendered as "Data Unavailable — the server might be unreachable" | **MEDIUM** | **Fixed** |
| 10 | Second pass — see section **J** | HIGH→MEDIUM | **Fixed** |

#### Finding 3 in detail — why it was invisible

`expandPermissions` consumes a legacy `_WRITE` alias and emits the granular
codes *in its place*; it never re-emits the alias. `holdsPermission` compares
exactly. So `authorize('EMPLOYEE_WRITE')` could not pass for anyone. Proven by
executing the real code:

| Role | holds `EMPLOYEE_CREATE` | `POST /users` allowed |
|---|---|---|
| HR_ADMIN | yes | **no** |
| ORG_ADMIN | yes | **no** |
| HR Manager AdGroup | yes | **no** |
| Legacy `EMPLOYEE_WRITE` role | yes | **no** |

The existing test asserted every guard code was *known* — and `EMPLOYEE_WRITE`
is known, since a role may still store one. It never asserted a code was
*reachable*. That is the gap, and it is now closed by a test rather than by
review (see section I).

#### The interaction that made ordering matter

Findings 2 and 3 were entangled. `PUT /users/:id` accepted
`role: PLATFORM_ADMIN`, and the only thing preventing exploitation was that
finding 3 made the route unreachable. **Fixing finding 3 alone would have
activated finding 2.** They were fixed together; the escalation tests were
written first and confirmed to pass for the wrong reason before the guard
existed.

---

## B. RBAC architecture (as it now stands)

```
Authentication      JWT (httpOnly cookie or Bearer), middlewares/auth.js
      ↓
User                users.role — a system role, worth a fixed permission set
      ↓             (utils/systemRolePermissions.js)
Role                AdGroup membership, permissions[] JSONB
      ↓
Permission          expandPermissions() folds role + groups into one effective
      ↓             set, baked into the JWT at login/refresh
Scope               tenantId (CLS, automatic via BaseScopedModel)
      ↓             factoryId (per-request, core/factoryAccess.js)
Resource            assertCanSeeRecord / scopeListToFactories
      ↓
Action              authorize('<RESOURCE>_<ACTION>') at the route
```

Effective permissions resolve as **union** across the system role and every
active AdGroup — additive only, so a second role can never remove access. The
wildcard `*` travels unexpanded (keeps the auth cookie under the 4 KB
per-cookie limit) and is interpreted by `holdsPermission`.

**Precedence:** deny-by-default. The only bypass is the two-role list in
`authorize.js`; everything else must be granted explicitly.

---

## C. Permission inventory

Generated from the catalog, not hand-listed: **206 grantable codes** (195
current + 11 deprecated `_WRITE` aliases retained for stored rows).

Shape: `<RESOURCE>_READ | _CREATE | _MODIFY | _DELETE`, plus named grants where
the act is deliberately not implied by write access:

```
VIEW_RATES                        PURCHASE_APPROVE
VIEW_PO_ATTACHMENTS               LEAVE_APPROVE
OVERRIDE_CURING                   PRODUCTION_APPROVE_VARIANCE
OVERRIDE_LOT_SELECTION            SALES_CREDIT_OVERRIDE
MIGRATION_RUN                     SALES_BUNDLE_OVERRIDE_MANDATORY
REPORT_<CATEGORY>_EXPORT  (11 categories)
```

Resources span 11 modules: Administration, Masters, Sales, Purchase,
Production, Inventory, Workforce, Finance, Reports & Analytics, Reports
(per-category), Audit.

**Drift check (backend catalog vs `front/src/constants/enums.js`):** the
frontend mirror is hand-maintained. One real gap —
`SALES_BUNDLE_OVERRIDE_MANDATORY` is missing from the frontend — plus the
deprecated `_WRITE` codes. All 30 codes referenced by the new route guards were
verified to exist in both.

---

## D. Page coverage

All 46 authenticated frontend routes now carry a permission gate. Previously
**zero** did.

| Module | Route | Gate |
|---|---|---|
| Dashboard | `/` | authenticated (API omits financial block without `VIEW_RATES`) |
| Common | `/notifications`, `/profile` | authenticated (self-service) |
| Administration | `/administration` | any of 7 admin reads |
| | `/employees` | `EMPLOYEE_READ` |
| | `/organization`, `/offices`, `/departments` | `ORG_READ` |
| | `/roles` | `ROLE_READ` |
| | `/roles/new`, `/roles/:id` | `ROLE_CREATE` or `ROLE_MODIFY` |
| | `/factories` | `FACTORY_READ` |
| | `/navigation` | `SETTINGS_MODIFY` |
| | `/settings` | `SETTINGS_READ` |
| | `/migration` | `MIGRATION_RUN` |
| | `/audit-log` | `AUDIT_READ` |
| Masters | `/masters` | any of 4 master reads |
| | `/products`, `/parties`, `/price-lists`, `/vehicles` | respective `_READ` |
| Sales | `/sales` | any of 7 sales reads |
| | `/sales-orders`, `/reservations` | `SALES_READ` |
| | `/dispatch`, `/invoices`, `/returns` | respective `_READ` |
| Purchase | `/purchasing` | any of 3 purchase grants |
| Production | `/production-module`, `/production`, `/quality` | respective reads |
| Inventory | `/inventory-module`, `/inventory`, `/transfers` | respective reads |
| Workforce | `/workforce` | any of 3 workforce reads |
| Finance | `/finance` | any of 6 finance reads |
| | `/payments` | `PAYMENT_READ` or `RECEIPT_READ` |
| | `/expenses`, `/gstr` | respective `_READ` |
| | `/ledger` | `LEDGER_READ` or `JOURNAL_READ` |
| Analytics | `/analytics` | `ANALYTICS_READ` |
| Reports | `/reports`, `/reports/:category[/:report]` | any of 7 report reads (per-report gating by API) |
| | `/reports/saved` | `REPORT_READ` |

Module landing gates are **derived from `NAVIGATION`** via the exported
`NAV_GATE`, so the sidebar and the router cannot disagree about who may open a
module.

---

## E. API coverage

357 routes / 38 routers. 337 carry `authorize(...)`. The 20 that do not:

| Route(s) | Why exempt |
|---|---|
| `POST /auth/login`, `/refresh`, `/logout`, `/forgot-password`, `/reset-password` | pre-authentication, rate-limited |
| `GET /auth/me` | authenticated; returns only the caller's own identity |
| `GET /dashboard/stats` | authenticated; financial block omitted server-side without `VIEW_RATES` |
| `GET/PUT /notifications/*` (4) | every user needs their own notification centre |
| `GET /reports/catalog`, `/:category/:report[/meta|/export]` (4) | permission depends on which report — checked in `resolveReport`, including a separate export grant |
| `POST/GET/DELETE /users/:id/documents*` (4) | `allowSelfOr(...)` — self-service or the `EMPLOYEE_*` grant |
| `POST /users/avatar` | self-service; setting your own picture is not user administration |

`allowSelfOr` was analysed for bypass: strict `===` between the JWT `userId` and
the URL param, falling through to the same `authorize` closure on mismatch. Sound.

---

## F. Files changed

### Backend

| File | Change |
|---|---|
| `src/api/roles/role.service.js` | `assignMember` now takes an actor and calls `assertGrantable` — closes escalation #1 |
| `src/api/roles/role.controller.js` | passes `req.user` to `assignMember` |
| `src/api/users/user.service.js` | new `assertRoleAssignable` guard on `create` and `update` — closes escalation #2 |
| `src/api/users/user.controller.js` | threads actor; new `downloadDocument` handler; `listDocuments` returns an API path, not a public file URL |
| `src/api/users/user.router.js` | granular `EMPLOYEE_CREATE/MODIFY/DELETE` guards; avatar upload made self-service; new gated `/file` route; multer hardened (10 MB cap, MIME allow-list, UUID-validated destination, sanitised filename) |
| `src/api/auth/auth.service.js` | system-role permission map extracted |
| `src/utils/systemRolePermissions.js` | **new** — one definition of what a system role confers, shared by login and the escalation guard |
| `src/app.js` | `/uploads` narrowed from the whole tree to `/uploads/assets` and `/uploads/avatars` |
| `tests/rbac.test.js` | +12 tests (reachability, user administration, privilege escalation, document access) |

### Frontend

| File | Change |
|---|---|
| `src/components/auth/require-permission.jsx` | **new** — route-level gate |
| `src/components/auth/access-denied.jsx` | **new** — shared denial panel; never names the required code |
| `src/components/auth/require-permission.test.jsx` | **new** — 9 tests |
| `src/App.jsx` | all 46 authenticated routes wrapped |
| `src/hooks/use-permissions.js` | now delegates to `lib/permissions.js` — one rule, not two |
| `src/constants/navigation.js` | exports `NAV_GATE`, derived from `NAVIGATION` |
| `src/components/layout/global-search.jsx` | Cmd-K filtered by permission |
| `src/components/query-state.jsx` | 403 renders Access Denied, not "server unreachable" |
| `src/pages/EmployeesPage.jsx` | dead `EMPLOYEE_WRITE` split into the three granular grants |
| `src/pages/RolesPage.jsx` | create / edit / delete gated |
| `src/components/roles/role-members-dialog.jsx` | assign / remove gated |
| `src/pages/SavedReportsPage.jsx` | save, delete and CSV/PDF export gated |
| `src/pages/ProductionPage.jsx` | variance Approve **and the Approvals tab** gated on `PRODUCTION_APPROVE_VARIANCE` |
| `src/components/employees/employee-documents-{tab,admin-dialog}.jsx` | downloads fetched with credentials; legacy gate corrected |

## G. Database changes

**None.** No migration was required. This is deliberate — every fix was an
authorization gap in application code, not a missing column. (One *open* finding
does need schema: see J-7, purchase indents have no `requestedBy` column, so a
self-approval guard cannot be written without one.)

---

## H. Security improvements

1. **Two privilege-escalation paths to superuser closed.** Both were reachable
   by a user holding one ordinary admin grant, and both bypassed `assertGrantable`
   by not going near role authoring.
2. **Role assignment is now a grant.** Putting someone in a role hands them its
   permissions, so it clears the same bar as authoring one.
3. **The user editor is no longer a second door onto the permission system.**
   `role` and `roleId` are both checked against what the actor holds.
4. **Employee documents are no longer public.** Served through a gated route
   that verifies ownership and tenancy, as `attachment` with `nosniff`.
5. **Upload hardening.** Size cap, MIME allow-list (blocks stored-XSS via
   `.html`/`.svg` on the API origin), and a path-traversal fix — `req.params.id`
   was URL-decoded and joined straight into an `mkdirSync` path.
6. **Deep links no longer reach every module.**
7. **Client authorization is consistent with the server** — the bypass list,
   the wildcard and the empty-list semantics now match.
8. **A refused request reads as a permission problem**, not an outage.

---

## I. Testing results

Executed, not asserted:

| Check | Result |
|---|---|
| Backend `jest` (full suite) | **1025 passed / 1025**, 68 suites, 112s |
| Backend RBAC suite | **59 passed / 59** (was 28 before this work) |
| Frontend `vitest` | **223 passed / 223**, 32 files (was 214) |
| Frontend `vite build` | passes |
| Frontend `eslint` (changed files) | 0 errors |
| Backend `eslint` | **not configured** — no `eslint.config.js`; `npm run lint` fails on any input. Pre-existing. |

Each new security test was confirmed to **fail before the fix**:

- `refuses to assign a role carrying permissions the actor does not hold` — 201 before, 403 after.
- `lets EMPLOYEE_CREATE create a user` — 403 before, 201 after.
- `never guards a route with a code no role can actually hold` — reported `EMPLOYEE_WRITE` before, empty after.

The two `PUT /users/:id` escalation tests initially passed **for the wrong
reason** (the route was unreachable). This was verified explicitly, which is
what surfaced the ordering dependency described in section A.

Negative controls included throughout, so the suite cannot pass by denying
everything: `still refuses a user who holds only EMPLOYEE_READ`, `still lets an
unrestricted admin assign any role`, `lets the bypass roles through`, `leaves an
untouched user's session alone`, `does not block an old indent whose author was
never recorded`.

**One caveat on how these numbers were obtained.** An intermediate run reported
42 failures that had nothing to do with the code: a jest run left over from an
earlier timeout was still alive, so two runs were truncating the same test
database concurrently. Individual files passed throughout. The figures above come
from a single run with nothing else touching the database, verified by process
check first. Run time is unchanged from before the permission-version check
(109s → 112s), so the extra per-request lookup costs nothing measurable.

**Not done:** no manual browser testing, and no load/performance measurement.

---

## J. Second pass — the remaining findings, now fixed

The first pass covered route guards and the highest-risk actions. This pass
closed the rest.

| # | Finding | Fix | Proven by |
|---|---|---|---|
| 1 | **Notifications had no audience at all.** `list` ignored both user and factory, so omitting `?factoryId=` returned every user's and every plant's alerts — credit-limit breaches, overdue receivables, negative cash. `markRead` used `findByPk`, so any user could mark another's alert read. `markAllRead` was tenant-wide and needed no permission: one call cleared everyone's queue. | `NotificationsService.audienceWhere` — mine or broadcast, within my factories — applied to all four operations. | 4 tests; 3 fail without the fix |
| 2 | **Record-level factory checks missing** on purchase indents (read/approve/reject/cancel/convert), the whole returns module (8 handlers, including cancels that reverse stock and ledger), expenses and transfers. | `guardIndent`, per-document guards in returns, `assertCanSeeRecord` in expenses. Transfers needed a new rule — a transfer names *two* plants, so `scopeListToEitherFactory` / `assertCanSeeTransfer` were added; the list had imported `scopeListToFactories` and never called it, and it would not have worked anyway (no `factoryId` column). | Existing suite + the self-approval tests, which 404 without a plant assignment |
| 3 | **`maskRateFields` did not recurse**, so every header-with-lines response returned `lines[].ratePaise` in full, and its default list named 4 of the codebase's 147 money fields — a sales invoice masked nothing. | Rewritten to walk the payload and key off the `*Paise` naming convention. The 27 narrow per-controller field lists were removed so every call site gets the complete rule. | 5 tests |
| 4 | **Legacy saved-report runners bypassed everything.** `run()` never received `req`, so factory scoping was never consulted and `params.factoryId` was honoured for any plant; `REPORT_READ` also substituted for the module permission, returning the trial balance without `LEDGER_READ`. | `assertMayRun` — module permission per report type, plus factory scoping. A restricted user who names no factory is refused rather than silently widened to all plants. | Updated `reports.test.js` fixtures |
| 5 | **Role assignment and user-role changes were not audited** — the most access-relevant writes in the product left no trace, and no delete anywhere was logged. | `AdGroupMember` and `User` are now `BaseAuditedModel`; added the missing `afterDestroy` hook. Credentials excluded from snapshots via `auditExclude`. | 4 tests; all 4 fail without the fix |
| 6 | **No protected role.** `ROLE_DELETE` could delete the seeded Platform Admin role, stripping every member's access and locking the tenant out. | `deleteRole` now refuses a role that out-ranks the actor, and refuses the last role carrying the wildcard. | — |
| 7 | **Self-approval was possible** on purchase indents and production variance — and for variance it was the *default*, since the seeded Production Supervisor holds both grants. Neither record stored who raised it, so the guard was unwritable. | Migration `20260926000000` adds `purchase_indents.requestedBy` and `material_consumptions.recordedBy`; both services now refuse an approver who is the author. Nullable with no backfill — unknown means "cannot prove", so historical rows are not retroactively blocked. | 3 tests + 1 in `sales-production` |
| 8 | **~21 frontend pages had no action gating** — Cancel Invoice, Cancel Sale, Cancel Transfer, Cancel Challan, price-list and org deletes, every "New …" button, the Migration import and the tenant-wide menu Save. | Gated against the same codes the API enforces, using the page's existing `hasPermission(user, …)` idiom. | Build + 223 tests |

### Third pass — the two items previously left open

| # | Finding | Fix | Proven by |
|---|---|---|---|
| 9 | **A revoked permission took up to an hour to bite.** Permissions ride in the access token and `authenticate` verified only its signature — no lookup, no denylist. Removing a permission from a role, removing someone from a role, deactivating a role, demoting a system role or disabling the account outright changed nothing until the token expired, and `revokeRefreshTokens` could not help because it only touches the refresh table. `JWT_ACCESS_EXPIRATION` defaults to **1 hour**, not the fifteen minutes several comments claimed. | Migration `20260927000000` adds `employees.permissionsVersion`. It travels in the token as a claim; `authenticate` compares it against the stored value and refuses a token minted before the last change. `utils/permissionVersion.js` bumps it from every write that alters access. The same lookup doubles as an account-status check, so a disabled user is out at once. `/refresh` and `/logout` are exempt, or a stale session could not recover. | 5 tests; the 3 revocation cases fail without it, the 2 controls pass either way |
| 10 | **`ORG_ADMIN` was a superuser under a name that does not read like one.** Its branch returned `Object.values(WebPermissions)` — every code, including `MIGRATION_RUN` and every override and approval grant. Because the grant came from code rather than a role row, it was invisible in Administration > Roles and no administrator could remove any of it. It is not in the `authorize.js` bypass list, so nothing about it looked privileged. | Narrowed from 206 codes to 65: the full administration surface (users, roles, org structure, locations, settings), read access across every module, the audit log and rate visibility — minus transactional writes and every named grant in `NEVER_BY_JOB_TITLE`. Reads are derived from the catalog so the list cannot fall behind. | 4 tests |
| — | **System-role grants had nowhere to be seen.** The roles screen shows role rows; permissions conferred by `users.role` came from code, which is how the above stayed hidden. | New `GET /api/v1/roles/effective-permissions/:userId` (requires `ROLE_READ` **and** `EMPLOYEE_READ`) returns the answer split by source: `fromSystemRole`, each role with whether it is `applied`, and the resolved `effective` set. This is the "effective permissions" view the brief asks for. | covered by the 4 tests above |

**`ORG_ADMIN` is a deliberate behaviour change.** Anyone relying on it as a
second superuser should be given a role carrying `*` instead — that grant is
then visible and revocable, which was the whole problem.

**Cost of the freshness check:** one indexed primary-key lookup of three columns
on every authenticated request. Measured across the full suite, run time was
unchanged (109s before, 106-115s after). A stateless token cannot be withdrawn
by definition, so this is what immediacy costs.

On the client, the existing 401 interceptor already refreshes transparently, so
a permission change is invisible to the user. The cached `currentUser` is now
invalidated on refresh (`query-provider.jsx`), or the UI would keep rendering
from the old grant while the server acted on the new one.

### Not RBAC, but found and worth acting on

- **`.env` is committed with live SMTP credentials** and points `DB_HOST` at a remote server. Its secrets are also too weak for the project's own validator, so `npm test` cannot run from a clean checkout.
- **`src/config/env.js` error text is wrong**: it suggests `openssl rand -hex 32` for `ENCRYPTION_KEY`, which produces 64 characters where exactly 32 are required.
- **Backend has no ESLint config**, so `npm run lint` cannot run.
