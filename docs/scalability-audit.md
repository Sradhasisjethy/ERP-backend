# Scalability, Concurrency and Performance Audit

INFIDEEP ERP — `ERP-backend` + `EPR-frontend`. Audited 2026-09-25 by inspecting the
code, the migrations, the live schema, and by measuring the running application
against the test database. No production code was changed and no destructive
database operation was run.

Every claim below is tagged:

- **Confirmed** — read from the code or measured.
- **Potential** — follows from the code but was not exercised under load.
- **Assumption** — stated because the repository cannot tell us.

---

## 1. Executive summary

**Can this application currently handle hundreds or thousands of users doing data
entry at the same time? No.** Not because of anything exotic, but because of
five concrete things, four of which are one-line to one-file fixes:

| # | Finding | Evidence | Effect under load |
| --- | --- | --- | --- |
| 1 | **The database pool is five connections.** No `pool` block in `src/config/database.js`, so Sequelize's default `max: 5` applies. | Confirmed | At most **five** database operations in flight per process. A sales-order create holds one for ~0.9 s against the current remote database. The sixth request waits; after 60 s it fails. |
| 2 | **Reports and exports run inside the HTTP request, on the one Node thread.** | Measured | A 10,000-row Excel export blocks the event loop for **5 s** and adds **235 MB** of heap; 50,000 rows (the configured default ceiling) blocks for **25 s** and adds **1.08 GB**. A 10,000-row PDF blocks for **15 s at ~100%**. While that runs, every other user's request waits. |
| 3 | **One Node process, single core.** `src/server.js` calls `app.listen` once; no cluster, no PM2. | Confirmed | All of the above compounds: one export freezes the whole tenant base. |
| 4 | **Login costs ~80–110 ms of main-thread CPU** (`bcryptjs`, pure JavaScript, cost 10). | Measured | Ten logins per second saturate a core. A Monday-morning login wave is a denial of service. |
| 5 | **The dashboard is 65 SQL round trips and every open dashboard polls it every 30 seconds.** | Measured (`GET /dashboard/stats`) | 200 people with the dashboard open is ~430 queries/second before anyone does any work. |

And two things this audit found that are **my own work from this week**, reported
here rather than hidden:

- `CounterSaleService.cancelCounterSale` wraps two service calls that each open
  their own transaction. Under this codebase's CLS configuration a nested
  `sequelize.transaction()` **does not become a savepoint — it takes a second
  connection** (measured: `parent = false, same connection = false`). The
  cancel is therefore not atomic and costs two pool slots. **Critical, and I
  will fix it as soon as this audit is accepted.**
- The master-data import commit holds a pool connection for the whole commit
  (minutes on a remote database), and the Chart of Accounts import is not
  atomic for the same nesting reason.

**Current realistic safe capacity, as deployed today** (one process, pool of 5,
database ~29 ms away): **roughly 30–50 concurrently active users** doing data
entry, and **zero tolerance for a large export while they do it**.

**After the fixes in §11, on modest hardware:** 500 concurrent users is
comfortable on two application instances; 1,000 on three to four; 5,000 needs
the database work in §11 (read replica, `audit_logs` partitioning) and a queue
for exports and imports.

---

## 2. Current architecture

| Layer | What is actually there (Confirmed) |
| --- | --- |
| Runtime | Node **v22.17.0**, Express **4.18**, Sequelize **6.35**, Postgres driver `pg` 8.11 |
| Process model | **One process, one core.** `src/server.js` → `app.listen`. The nightly scheduler (`src/jobs/scheduler.js`) runs **inside** the API process on a `setInterval`. |
| Database | **PostgreSQL 18.6** on Ubuntu/aarch64 at `18.61.3.32` — a self-managed VM, not RDS (Assumption from the version string; the repo does not say). `max_connections = 100`, `shared_buffers = 128MB` (Postgres default), `work_mem = 4MB`, `statement_timeout = 0`, `idle_in_transaction_session_timeout = 0`, no extensions beyond `plpgsql`. Database size **20 MB**. |
| Multi-tenancy | Row-level `tenantId` on every table, injected through `cls-hooked` + `BaseScopedModel` hooks. Every scoped query carries `WHERE tenantId = …`. |
| Auth | JWT in cookie/bearer. **Every authenticated request does one `SELECT` on `employees`** (`src/middlewares/auth.js:53`) to check `permissionsVersion` and `status`. |
| Rate limiting | `express-rate-limit` with its default **in-memory store**; off unless `RATE_LIMIT_ENABLED=true`. |
| Idempotency | Database-backed (`idempotency_keys`), unique index — correctly designed. |
| Uploads | `multer` to the **local filesystem** (`uploads/employees`, `uploads/avatars`); 10 MB and 2 MB limits. Master-data imports go to memory (5 MB). |
| Audit | `BaseAuditedModel` writes an `audit_logs` row with **full before/after JSON** on every create/update. Already the largest table in the development database. |
| Logging | `morgan` → `winston` **Console transport only**, one line per request. |
| Frontend | React 19 + Vite. react-query `staleTime: 60s`, `refetchOnWindowFocus: false`. Main bundle **1.54 MB** (384 KB gzip). Dashboard polls every **30 s**; unread-count polls every **60 s**. |
| Deployment | `docker-compose.yml` defines Postgres only. No Dockerfile for the API, no process manager, no reverse proxy config in the repo. (Missing information: how production is actually run.) |

---

## 3. Backend scalability findings

### Confirmed

**B1. No connection pool configuration** — `src/config/database.js`. Sequelize 6
defaults: `max 5, min 0, acquire 60000 ms, idle 10000 ms`. This is the single
hardest ceiling in the system. See §5.

**B2. Every request pays a database round trip before its handler runs** —
`src/middlewares/auth.js:53`, `User.unscoped().findByPk(...)`. It is a
primary-key lookup (cheap on the server) but it is a round trip through the
five-slot pool on every call, including the 60-second notification poll.

**B3. Exports run in-request and block the event loop** — measured in §8. The
XLSX path builds the entire workbook in memory (`workbook.xlsx.writeBuffer()`),
the PDF path streams but `pdfkit` layout is synchronous. `REPORT_EXPORT_MAX_ROWS`
defaults to **50,000** (`src/config/env.js:124`).

**B4. `bcryptjs` on the main thread** — `src/api/auth/auth.service.js:157`.
Pure-JS bcrypt at cost 10 measured at **78–108 ms CPU per compare**. The native
`bcrypt` package does the same work off-thread in libuv's pool in ~3 ms of main
thread time.

**B5. Nested transactions open a second connection.** Measured:

```
nested transaction: parent set = false | same connection = false
```

The repository's own `npm run check:transactions` scanner exists for this reason
and currently flags exactly two sites, both mine: `cancelCounterSale →
cancelReceipt` and `cancelCounterSale → cancelInvoice`. Under load each such
call needs two pool slots and can deadlock the pool (the outer holds one and
waits for an inner that can only be granted when a sibling commits).

**B6. Write endpoints are long chains of sequential round trips.** Measured
through the real Express app (`api_query_counts.js`, test database):

| API | SQL round trips | Transactions | Audit rows written | ms (incl. ~29 ms/trip network) |
| --- | ---: | ---: | ---: | ---: |
| `POST /auth/login` | 5 | 0 | 1 | 706 |
| `GET /auth/me` | 4 | 0 | 0 | 140 |
| `GET /dashboard/stats` | **65** | 3 | 0 | **1,756** |
| `GET /parties` (page) | 6 | 0 | 0 | 199 |
| `GET /parties?search=` | 6 | 0 | 0 | 190 |
| `GET /products` (page) | 5 | 0 | 0 | 148 |
| `GET /invoices` (page) | 6 | 0 | 0 | 174 |
| `GET /notifications` | 7 | 0 | 0 | 237 |
| `POST /production/entries` | 42 | 1 | 5 | 1,367 |
| `POST /sales/orders` (1 line) | 28 | 1 | 3 | 947 |
| `PUT /sales/orders/:id/confirm` | 19 | 1 | 3 | 652 |
| `POST /dispatch/challans` | 37 | 1 | 6 | 1,200 |
| `POST /invoices` (from challan) | 46 | 1 | 2 | 1,472 |
| `POST /receipts` (allocated) | 30 | 1 | 2 | 952 |
| `POST /retail/counter-sales` (paid) | **71** | 1 | 5 | **2,208** |
| `POST /products` | 7 | 0 | 1 | 236 |

Each write holds one pool connection for its whole transaction. The round-trip
count, not the query cost, is what the clock measures: with the database next
to the application (~1 ms) the same counter sale is ~100 ms; at 29 ms it is 2.2 s.

**B7. The scheduler is in-process and keyed on process memory** —
`lastRunDate` and `running` are module variables. Two instances would both run
the nightly batch.

**B8. Rate limiting is per process** (memory store). Two instances means two
independent 100-request buckets per IP, and a restart resets them.

**B9. Uploaded files are on local disk.** A second instance cannot serve a file
the first one received.

**B10. No response compression.** `compression` is not a dependency; list
payloads go out uncompressed. A 200-row party page is ~150 KB.

**B11. Write amplification through the audit log.** A challan writes 6 audit
rows with full JSON snapshots; a counter sale 5. `audit_logs` is already the
largest table (1,769 rows, 2.5 MB, with 8 invoices in the system).

**B12. The master-data import commit pins one pool connection for its entire
duration** — one minute per ~600 rows against the current database — 20 % of
the pool. The Chart of Accounts import calls `AccountsService.create`, which
opens its own transaction, so that import is **not atomic** across rows.

### Potential

**B13. `winston` Console transport under high request rates.** Each request logs
one line synchronously to stdout. At several hundred requests/second with stdout
attached to a slow consumer this back-pressures the process. Not measured.

**B14. `findAndCountAll` with `include` (53 sites).** For `belongsTo` includes
(the common case here) the count query carries an unnecessary join on a primary
key — cheap. It becomes expensive only if a `hasMany` include is added without
`distinct: true`.

**B15. No pruning of `refresh_tokens` or `idempotency_keys`.** No `destroy` for
either anywhere in `src/`. One row per login and per idempotent request, for
ever. 99 refresh tokens exist for 24 users today.

### Assumptions

- Production runs one instance on one host, the way `server.js` implies. The
  repository carries no Dockerfile, PM2 file or reverse-proxy configuration.
- The database will be co-located with the application in production (same
  region). Every latency figure is given both ways.

---

## 4. Database scalability findings

### Confirmed

**D1. Server is at stock defaults.** `shared_buffers = 128MB` on a machine
whose `effective_cache_size` hint says 4 GB; `work_mem = 4MB`; **no
`statement_timeout`, no `idle_in_transaction_session_timeout`**. A request that
dies mid-transaction holds its connection — and the pool slot — indefinitely.

**D2. `max_connections = 100`.** With one process at pool 5 that is fine. With
the pool raised to 20 and four instances it is 80 — plus migrations, the nightly
job, and anyone's `psql`. It needs raising or a pooler (§12).

**D3. Concurrency-critical paths are correctly locked.**

- Document numbering (`documentNumbering.service.js:114`) takes
  `SELECT … FOR UPDATE` on the series row then increments it — correct; 100
  simultaneous invoices serialise on that row and get distinct numbers.
- FIFO stock consumption (`stockLedger.service.js:143, 251`) locks lots
  `FOR UPDATE` in FIFO order — consistent ordering, so no deadlock between two
  sellers of the same product.
- Idempotency claims a row **before** the handler runs and relies on the unique
  index.
- Optimistic locking (`lockVersion`) on human-edited masters.

**D4. But the development database is missing 44 of the 61 unique indexes the
migrations define** — including `sales_invoices_tenant_number_unique`. (Found
and reported separately on 2026-09-24; a repair migration is written and waiting
for approval.) On that database, D3's guarantees for document numbers hold only
because the allocator is also row-locked; nothing at the schema level stops a
duplicate.

**D5. Search is `ILIKE '%term%'` on six columns with no trigram index.**
`listParties` ORs `ILIKE` across `name, code, gstin, phone, aadhaarNumber,
badgeNumber`; products, invoices and orders do the same on their columns. No
`pg_trgm`, no GIN index (checked: 0). A leading-wildcard `ILIKE` cannot use a
B-tree index — every search is a sequential scan of the tenant's rows. At 1,000
parties that is invisible; at 500,000 it is a 100–300 ms scan per keystroke
from every open picker.

**D6. `audit_logs` has no index the audit screen can use.** The only index is
`(tenantId, entityType, entityId)`; the list is `ORDER BY createdAt DESC` per
tenant → sort of the whole tenant's audit history on every page view. This is
the fastest-growing table in the system.

**D7. `employees` has no `tenantId` index** — only `email` and the PK. Every
scoped query on it filters `tenantId` without an index. Small table; low today.

**D8. The rest of the hot-path indexes are good.** Sales invoices, orders,
challans, receipts, journal lines, stock ledger and stock lots all carry
`(tenantId, factoryId, date)`-shaped indexes matching the dashboard and report
predicates (`rpt_*` indexes, evidently added for the reports module).

### What happens if 100 users submit at exactly the same time

With the current pool of 5 (Confirmed behaviour, Potential outcome):

1. Five sales orders begin. Each holds a connection for ~28 sequential round
   trips (~0.9 s remote, ~40 ms co-located).
2. The other 95 wait on `pool.acquire`. Remote: the queue drains at ~5–6 per
   second, so the 95th waits ~17 s. Nobody fails — until a user's browser,
   proxy, or the 60 s `acquire` timeout gives up.
3. Every *read* in that period — every list page, every notification poll —
   sits in the same queue behind the writers.
4. Document numbers stay unique (D3). Stock stays consistent (D3). The books
   stay balanced. **Correctness survives; throughput does not.**
5. If any one of those 100 is an export, add 5–25 s during which the process
   answers nothing at all.

With the pool at 25 and the database co-located: all 100 complete in roughly
one to two seconds, and the next limit is CPU.

---

## 5. Connection pool analysis

| Setting | Value | Source |
| --- | --- | --- |
| `max` | **5** | Sequelize default; not set |
| `min` | 0 | default |
| `acquire` (wait before giving up) | 60,000 ms | default |
| `idle` | 10,000 ms | default |
| Server `max_connections` | 100 | measured |
| Server `statement_timeout` | none | measured |
| Server `idle_in_transaction_session_timeout` | none | measured |

**Realistic concurrent request capacity per process, today:**

- Writes: ~5 in flight. Throughput ≈ 5 ÷ (transaction time). Remote database:
  ~5 writes/s. Co-located: ~60–120 writes/s.
- Reads: ~5 in flight; each is 4–7 round trips. Remote: ~25–35 reads/s.
  Co-located: several hundred/s.
- A single import commit or a large report holds a slot for its duration.

Connections **are** released correctly on the normal path (Sequelize manages
this). The two failure modes are: (a) nested transactions taking a second slot
(B5) — with 3 concurrent counter-sale cancels the pool is exhausted; (b) a
transaction that never commits because the process is blocked by an export —
which the missing `idle_in_transaction_session_timeout` then never reclaims.

**Recommended** (see §11 for rationale): `pool: { max: 20–25, min: 2, acquire:
15000, idle: 10000 }` per process; server `statement_timeout = 30s`,
`idle_in_transaction_session_timeout = 60s`; raise `max_connections` to 200 or
put PgBouncer (transaction mode) in front once there are more than two
instances.

---

## 6. API concurrency analysis

| API | DB queries | Heavy operation | Bottleneck under concurrency | Risk today | Fix |
| --- | ---: | --- | --- | --- | --- |
| `POST /auth/login` | 5 | bcryptjs ~100 ms CPU | Main-thread CPU; 10/s saturates a core | **High** | Native `bcrypt` (off-thread) |
| `GET /auth/me` | 4 | — | Pool slot per call | Low | Cache 60 s client-side (done) |
| `GET /dashboard/stats` | **65** | 3 transactions, ~12 aggregate scans | Pool + DB CPU; **polled every 30 s per tab** | **High** | Server-side cache 30–60 s per (tenant, factory); collapse to 3–4 SQL statements; poll 60–120 s |
| `GET /parties?search=` | 6 | 6-column `ILIKE '%…%'` | Sequential scan per keystroke as parties grow | Medium (High at 100k+) | `pg_trgm` GIN indexes |
| `GET /invoices`, `/orders` | 6 | count + page + outstanding-in-one-query | Fine | Low | — |
| `POST /sales/orders` | 28 | credit check, reservation, numbering | Holds a slot ~30 ms co-located / 0.9 s remote | Medium | Pool size; co-locate DB |
| `POST /invoices` | 46 | numbering, GST, journal, stock, audit | As above | Medium | Pool size |
| `POST /retail/counter-sales` | 71 | numbering, FIFO, journal, receipt, audit | Longest write chain | Medium | Pool size; batch line inserts |
| `POST /retail/counter-sales/:id/cancel` | ~60 | **two nested transactions** | Two pool slots; not atomic | **Critical** | Thread the transaction (§11) |
| `POST /reports/export` (xlsx) | COUNT + 1 SELECT | In-memory workbook | **Blocks event loop 5–25 s, +235 MB–1 GB** | **Critical** | Worker + streaming writer; cap 10k rows meanwhile |
| `POST /reports/export` (pdf) | COUNT + 1 SELECT | pdfkit layout | **Blocks event loop 15 s at 10k rows** | **Critical** | Worker; cap rows |
| `POST /master-data/:m/import/validate` | 7 | Excel parse + 3 RTT probes | Cheap | Low | — |
| `POST /master-data/imports/:id/commit` | 2–3 per row | Sequential service calls | Pins a slot for minutes; accounts non-atomic | High | Batch; run off-request for >500 rows |
| `GET /notifications/unread-count` | ~3 | — | 1 per user per minute, all users | Low | Fine |
| `GET /reports/:id` with non-UUID | 1 | — | Returns **500** instead of 400 | Low | Validate `:id` |

---

## 7. Query and index analysis

**Indexes that exist and are right** (from the migrated schema): every
transactional table has `(tenantId, factoryId, date)`, every line table has
`(tenantId, parentId)` and `(tenantId, productId)`, `journal_lines` has account
and party indexes, `parties` has type/status/name, `products` has all its
foreign keys. This is better than most codebases of this size.

**Missing, with the query each would serve:**

| Index | Serves | Why |
| --- | --- | --- |
| `audit_logs (tenantId, createdAt DESC)` | `AuditLogService.list` — `ORDER BY createdAt DESC` per tenant | Fastest-growing table, sorted on every page view with no usable index. |
| `GIN (name gin_trgm_ops), (code gin_trgm_ops)` on `parties`, `products`; `(invoiceNumber)` on `sales_invoices`; `(orderNumber)` on `sales_orders` | Every `ILIKE '%term%'` search and every searchable picker | Leading-wildcard `ILIKE` cannot use B-tree. Needs `CREATE EXTENSION pg_trgm`. |
| `employees (tenantId)` | every scoped query on employees | Only `email` is indexed. |
| `payment_allocations (receiptId)` | `cancelReceipt`, `counterSaleSettledBy` | Only `(tenantId, invoiceType, invoiceId)` exists; receipt-side lookups scan. Small. |
| `sales_orders (tenantId, status)` | dashboard open-orders count | Currently uses the factory/date index and filters status. Fine until orders are in the hundreds of thousands. |

**Indexes to remove:** none found unnecessary.

**Queries that grow with data:**

- Dashboard aggregates (`SUM`, `COUNT` over invoices/lots/orders by month) are
  index-supported but still scan the month's rows on every 30 s poll. Cache.
- `LedgerService.getAccountBalance` sums every journal line for an account,
  every call. Correct, and fine to ~10⁶ lines; beyond that a running balance
  or monthly snapshot is the standard remedy.
- Report definitions use `LEFT JOIN LATERAL` sub-selects for collected amounts
  per invoice — proportional to rows returned, bounded by the 50,000-row export
  cap, and index-supported. Fine.

---

## 8. Report and export analysis

Exports run **inside the HTTP request** (`src/api/reports/export/index.js`).
Measured on this machine, event-loop blocking read from a 10 ms timer that could
not fire:

| Format | Rows | Wall time | Heap added | Event loop blocked |
| --- | ---: | ---: | ---: | ---: |
| XLSX | 1,000 | 0.9 s | 10 MB | 81 % |
| XLSX | 10,000 | 5.0 s | 235 MB | 85 % |
| XLSX | **50,000** (the default ceiling) | **25 s** | **1,077 MB** | 87 % |
| PDF | 1,000 | 0.7 s | 24 MB | ~100 % |
| PDF | 10,000 | **15.4 s** | 98 MB | **~100 %** |

What that means:

- **10 simultaneous 10k-row exports:** the process spends ~50 s doing nothing
  else. Every other user's request — login, save, list — waits ~50 s. Heap
  peaks at ~2.3 GB and a 2 GB container is killed.
- **50 simultaneous:** the process is unresponsive for minutes; the load
  balancer health check fails and restarts it, dropping every in-flight
  transaction.
- **100 simultaneous:** not reachable — it dies at 10.
- The database is *not* the problem here: each export is one `COUNT` and one
  `SELECT`.

**Recommendation, in order:**

1. **Now, one line:** `REPORT_EXPORT_MAX_ROWS=10000` in the environment. Removes
   the 1 GB/25 s case. (The code already refuses above the cap with a clear
   message.)
2. **Streaming XLSX:** ExcelJS has `stream.xlsx.WorkbookWriter`, which writes
   rows to the response as they are formatted. Memory becomes constant; wall time
   stays but is spread across I/O yields, so blocking drops from ~85 % to a few
   percent. Same package, no new dependency.
   **DONE 2026-09-25.** `xlsx.js` now writes through `WorkbookWriter` straight
   to the response, with `useSharedStrings: false` and a `setImmediate` yield
   every 100 rows. Re-measured on the same machine, same harness:

   | Format | Rows | Wall time | Heap added | Event loop blocked |
   | --- | ---: | ---: | ---: | ---: |
   | XLSX (streamed) | 10,000 | **1.9 s** (was 5.0) | **22 MB** (was 235) | ~45–70 % |
   | XLSX (streamed) | 50,000 | **8 s** (was 25) | **60 MB** (was 1,077) | ~75 % |

   Memory is solved: the 2 GB-container death at ten simultaneous exports is
   gone. Time is halved. The loop is still mostly busy because cell styling is
   CPU work between the yields, which is why step 3 remains the real fix; the
   yields only guarantee that nothing else waits longer than ~15 ms at a time.
   PDF is unchanged (still in-request, ~100 % blocked).
   **Step 3 DONE 2026-09-25.** `export/workers.js` is a pool of at most
   `min(4, cpus-1)` threads; `export/worker.js` builds the file and posts it
   back chunk by chunk with pause/resume backpressure from the socket. Only
   plain data crosses (the definition is reduced to name/description). Beyond
   20 queued exports the caller gets a 503 "try again" rather than a held
   connection. Measured against an idle baseline (a 10 ms timer on Windows
   already misses ~37 % of ticks, so that is the floor):

   | Build | Rows | Wall time | Main loop blocked |
   | --- | ---: | ---: | ---: |
   | idle | — | — | 37 % (floor) |
   | XLSX in-request (streamed) | 10,000 | 4.6 s | 77 % |
   | XLSX on worker | 10,000 | 5.7 s | **37 %** |
   | XLSX on worker | 50,000 | 21 s | **37 %** |
   | PDF in-request | 10,000 | 26 s | ~100 % |
   | PDF on worker | 10,000 | 26 s | **36 %** |

   The file takes as long to build as before (a second longer for XLSX: the
   thread spawn and the copy of the rows across), but the main thread is now
   free for the whole of it — other users' requests are served while an export
   runs. Tests: `tests/export-workers.test.js`.
3. **Move exports to a worker.** Node's built-in `worker_threads` is enough
   for this: the request enqueues, a worker (one per core, in a small pool)
   builds the file, the response streams it back. No Redis, no queue service.
   This is justified by the numbers above; a queue product (BullMQ) is *not*
   justified until exports need to survive a process restart or run on another
   machine, which is Stage 3 in §12.

---

## 9. Data growth analysis

Today: 20 MB, 8 invoices, 1,017 parties, 1,769 audit rows.

| Data volume | What stops scaling first | Why |
| --- | --- | --- |
| 100,000 records | Nothing structural. | Indexes cover the hot paths. |
| 1,000,000 | **Party/product search** (D5) and **the audit screen** (D6). | Sequential scans of 100k+ rows per keystroke; audit sort over millions of rows. |
| 10,000,000 | **`audit_logs`** itself (it will be 5–10× the transactional data — 6 rows per challan) and **`getAccountBalance`** summing millions of lines. | Partition `audit_logs` by month; move old partitions off; introduce balance snapshots. |
| 50,000,000 | Single-node Postgres I/O; reports scanning years of invoices. | Read replica for reports; date-range enforcement on reports; archive closed financial years. |

By user count, with the §11 fixes applied:

| Users | Limiting factor | Notes |
| --- | --- | --- |
| 100 | none | One 2-vCPU instance. |
| 500 | Node CPU (logins, JSON, exports) | Two instances. |
| 1,000 | Database CPU on dashboard aggregates and searches | Cache dashboard; trigram indexes; replica for reports. |
| 5,000 | Connection count, `audit_logs` write rate, export volume | PgBouncer, partitioning, export queue. |

---

## 10. Frontend → backend traffic

**Per page load (Confirmed from the hooks):**

- App shell: `/auth/me` (cached 60 s), `/roles/permission-catalog` (cached
  forever), `/notifications/unread-count` (**every 60 s**).
- A list page: 1 list request per page/search/sort change (debounced 300 ms —
  good).
- **Dialogs are mounted unconditionally**, so their master-data fetches fire on
  page load whether or not the dialog is opened. `PurchasingPage` mounts six
  dialogs which fire `useFactories` ×3, `useProducts` ×3, `usePurchaseOrders`
  ×2 — react-query deduplicates identical keys, so that is **~4 extra requests
  per first visit**, each `limit: 100`.
- Dashboard: **1 request of 65 queries, every 30 s while open.**

**Estimated load per active user** (Assumption: a data-entry user performs one
action every ~30 s; each action is ~1.5 requests including the list refresh;
20 % of users have the dashboard open):

| Concurrent users | Requests/s | SQL queries/s (avg ~12/request + dashboard) |
| ---: | ---: | ---: |
| 100 | ~7 | ~130 |
| 500 | ~35 | ~650 |
| 1,000 | ~70 | ~1,300 |

**These are estimates derived from the measured per-API counts above, not
measurements of real traffic.** The dashboard poll alone is ~2.2 queries/s per
viewer; it is the largest single contributor and the easiest to remove.

---

## 11. Identified bottlenecks and recommended fixes (ranked)

| # | Priority | Where | Problem | Fix |
| --- | --- | --- | --- | --- |
| 1 | **Critical** — **DONE 2026-09-25** | `src/config/database.js` | Pool `max: 5` by default. Five in-flight DB operations per process. | `pool: { max: 25, min: 2, acquire: 15000, idle: 10000 }` and both timeouts set as session options on the connection, so they travel with the app. |
| 2 | **Critical** — **DONE 2026-09-25** (cap, streaming, worker pool) | `src/api/reports/export/{index,xlsx,pdf}.js` | Exports block the event loop 5–25 s and allocate up to 1 GB inside the request. | Default `REPORT_EXPORT_MAX_ROWS` lowered to 10,000 in `env.js`; XLSX streams via `WorkbookWriter` (10k rows: 235 MB → 22 MB, 5 s → 1.9 s). XLSX and PDF now build on a `worker_threads` pool (`export/workers.js`): main-thread blocking during a 10k-row export fell from 77–100 % to the idle floor. |
| 3 | **Critical** — **DONE 2026-09-25** | `src/api/retail/counterSale.service.js` `cancelCounterSale` (mine) | Two nested `sequelize.transaction()` → two connections, not atomic. | `cancelReceipt` and `cancelInvoice` now take an optional `transaction` and reuse it; `check:transactions` reports zero nested sites. |
| 4 | **High** — **DONE 2026-09-25** | `src/api/auth/auth.service.js` | `bcryptjs` ~100 ms main-thread CPU per login. | Replace with `bcrypt` (native; same API, same hashes, off-thread). |
| 5 | **High** | `src/server.js` | One process, one core. | Run under PM2 cluster or Node `cluster` with one worker per core — **after** items 6–8, or the cluster misbehaves. |
| 6 | **High** — **DONE 2026-09-25** | `src/jobs/scheduler.js` | In-process, memory-keyed; multiple instances run the nightly job multiple times. | Take a Postgres advisory lock (`pg_try_advisory_lock`) at the start of `runNightly`; the loser skips. No new infrastructure. |
| 7 | **High** | `src/middlewares/rateLimiter.js` | Memory store; per-instance buckets. | For ≤2 instances, accept it and document. For more, `rate-limit-postgresql` or a Redis store. |
| 8 | **High** | `src/api/users/user.router.js` uploads | Local disk. | Object storage (S3) for employee documents and avatars; serve through the existing authenticated endpoint. |
| 9 | **High** — cache + 90 s poll **DONE 2026-09-25**, query collapse pending | `src/api/dashboard/dashboard.service.js` + `use-dashboard.js` | 65 queries per call, polled every 30 s per tab. | Cache the assembled payload per (tenant, factoryIds, permissions) for 30–60 s in process memory (a `Map` with TTL is enough at ≤2 instances); poll at 90 s; collapse the widget queries into 3–4 SQL statements with `FILTER (WHERE …)`. |
| 10 | **High** — **DONE 2026-09-25** | migrations | `audit_logs` unsorted for its own screen. | `CREATE INDEX audit_logs_tenant_created ON audit_logs ("tenantId", "createdAt" DESC)`. |
| 11 | **Medium** — **DONE 2026-09-25** (`pg_trgm` enabled on dev DB, 6 GIN indexes) | migrations | Leading-wildcard `ILIKE` searches scan. | `CREATE EXTENSION pg_trgm; CREATE INDEX … USING gin (name gin_trgm_ops)` on `parties.name/code`, `products.name/code`, `sales_invoices.invoiceNumber`, `sales_orders.orderNumber`. |
| 12 | **Medium** — accounts atomic **DONE 2026-09-25**, chunking pending | `src/api/masterData/masterData.service.js` (mine) | Commit pins a connection for minutes; accounts import non-atomic. | Chunk commits of >500 rows into batches of 200 each in its own transaction with a resumable run status; give `AccountsService.create/update` an optional `transaction`. |
| 13 | **Medium** — **DONE 2026-09-25** (59 list hooks in 38 dialogs take `{ enabled: open }`) | `EPR-frontend` pages | Dialogs always mounted; their list hooks fire on every page load. | Pass `enabled: open` to the hooks inside dialogs, or mount the dialog only when open. |
| 14 | **Medium** — **DONE 2026-09-25** | `src/app.js` | No compression. | `app.use(compression())` (one dependency, 30 lines). |
| 15 | **Medium** — **DONE 2026-09-25** | `src/jobs/nightly.js` | No pruning of `refresh_tokens` (expired) or `idempotency_keys` (>24 h). | Two `destroy` calls in the nightly job. |
| 16 | **Medium** — **DONE 2026-09-25** (41 pages `React.lazy`; main chunk 1.54 MB → 579 KB) | `EPR-frontend` build | 1.54 MB main chunk. | Route-level `React.lazy` for Reports, Analytics, Ledger. |
| 17 | **Low** — **DONE 2026-09-25** | `src/api/reports/reports.router.js` `GET /:id` | Non-UUID id → 500. | `z.string().uuid()` on `params`. |
| 18 | **Low** — **DONE 2026-09-25** | migrations | `employees (tenantId)`, `payment_allocations (receiptId)` unindexed. | Add both. |
| 19 | **Low** | `src/utils/logger.js` | Synchronous console transport at high rps. | Acceptable to ~200 rps; beyond that, pino or an async transport. |
| 20 | **DONE 2026-09-25** | development database | 44 unique indexes missing (already reported). | `20260928000000-restore-unique-indexes.js` applied; 43 restored. `financial_years_tenant_code_unique` applied 2026-09-26 via `20260930000000-financial-years-unique-code.js` after the empty CLOSED duplicate `2027-28` was deleted through `deleteFinancialYear`. All 61 restored. |

---

## 12. Infrastructure requirements

Deliberately modest. Nothing here needs Kubernetes, microservices or Kafka.
Redis appears only at Stage 3, and only for two specific jobs.

### Stage 1 — 100 concurrent users

- **App:** 1 host, 2 vCPU, 2 GB RAM. PM2 cluster with 2 workers. Pool 15 per
  worker (30 total).
- **DB:** 2 vCPU, 4 GB RAM, **same region/VPC as the app** (this alone is worth
  more than every other change combined: it takes a counter sale from 2.2 s to
  ~100 ms). `shared_buffers = 1GB`, `max_connections = 100`.
- **Storage:** local disk is tolerable at one host, but move uploads to object
  storage now while it is small.
- **Cache / queue / replica:** none.
- **Monitoring:** `pg_stat_statements` on, `log_min_duration_statement = 500ms`,
  a process-level dashboard (PM2's is enough), an uptime check on `/health/live`.

### Stage 2 — 500 concurrent users

- **App:** 2 hosts × (2 vCPU, 4 GB), 2 workers each, behind nginx or an ALB.
  Pool 15 per worker (60 total).
- **DB:** 4 vCPU, 16 GB. `max_connections = 200`. Items 1–11 of §11 applied.
- **Exports:** `worker_threads` pool in each app process (no queue product yet).
- **Coordination:** advisory lock for the nightly job (§11 #6). Rate limiter
  stays in-memory (two buckets per IP is acceptable) or moves to a Postgres
  store.
- **Storage:** object storage, mandatory (two hosts).

### Stage 3 — 1,000 concurrent users

- **App:** 3–4 hosts, 2 workers each. Pool 10 per worker → **PgBouncer in
  transaction mode** in front of Postgres so 80 app connections map to ~30
  server connections.
- **DB:** 8 vCPU, 32 GB. **One read replica** for the Reports module and
  analytics (the report SQL is already separated in `definitions/*.js`; point
  `executeReport` at a second Sequelize instance).
- **Redis** (small, single node): the rate-limit store, and a 60 s cache for the
  dashboard payload shared across instances. This is the first point where an
  in-process cache is no longer enough.
- **Exports/imports:** still `worker_threads`; consider a queue only if exports
  must survive restarts.

### Stage 4 — 5,000 concurrent users

- **App:** 6–8 hosts, load balanced; frontend on a CDN.
- **DB:** 16 vCPU, 64 GB, PgBouncer, 1–2 replicas. **Partition `audit_logs`
  by month**; archive closed financial years' lines to cold tables; balance
  snapshots for `getAccountBalance`.
- **Queue:** BullMQ on Redis for exports and large imports, run by dedicated
  worker hosts — justified now because a 6-host fleet cannot rely on in-process
  workers and restarts must not lose a 50,000-row export.
- **Observability:** centralised logs (pino → Loki/CloudWatch), APM traces on
  the write chains in §6.

---

## 13. Load testing plan

**Tool:** k6. Scripted in JavaScript like the app, runs from one machine, and
its thresholds fail the run automatically.

**Safety — non-negotiable:**

1. Never against production. Restore the latest dump into a **staging database**
   (`pg_restore` into a fresh instance); point a staging app at it.
2. Use a **dedicated load-test tenant** created by the script; every record it
   creates carries that `tenantId`, and the teardown deletes the tenant (the
   schema cascades from `tenants`).
3. `RATE_LIMIT_ENABLED=false` on staging for the run, and SMTP pointed at a sink
   (the app sends welcome emails).
4. Snapshot the staging database before the first run so it can be reset.

**Common thresholds** (fail the run if breached):

| Metric | Target |
| --- | --- |
| p95 response time, reads | < 500 ms |
| p95 response time, writes | < 1,500 ms |
| p95, exports | < 10 s |
| Error rate (5xx + timeouts) | < 0.5 % |
| App CPU | < 75 % sustained |
| App RSS | < 70 % of container limit, no monotonic growth over the run |
| DB CPU | < 70 % |
| DB connections in use | < 80 % of `max_connections`; pool `acquire` timeouts = 0 |

**Scenario A — 100 users, normal data entry.** 100 VUs, 15-minute soak. Loop:
login once → list orders → create sales order (1–3 lines) → confirm → list
invoices → sleep 20–40 s. Expect ~7 rps.

**Scenario B — 500 users, normal operations.** 500 VUs, 20 minutes, ramp over
5 minutes. Same loop plus 20 % of VUs on a dashboard-poll loop (every 30 s).
Expect ~35 rps.

**Scenario C — 1,000 users.** 1,000 VUs, 30 minutes, ramp over 10. As B.
Expect ~70 rps. Watch pool acquire timeouts and DB connections first.

**Scenario D — mixed workload.** 500 VUs, 30 minutes:

| Share | Behaviour |
| --- | --- |
| 60 % | data entry (orders, challans, invoices, receipts, counter sales) |
| 20 % | party/product/invoice searches, 3–5 keystrokes each |
| 10 % | dashboard open, polling |
| 5 % | updates (edit party, edit product, cancel order) |
| 5 % | exports: 80 % ≤ 1k rows, 20 % 10k rows, XLSX and PDF |

The 5 % export share is the important one: run D **before and after** §11 #2 and
compare p95 for the *other* 95 %. That difference is the event-loop blocking made
visible.

**Recording:** `pg_stat_statements` reset before each run; export the top 20
by total time afterwards. That list is the index plan for the next iteration.

---

## 14. Current capacity estimate

As deployed today — one process, pool 5, database ~29 ms away, no fixes:

| | Estimate | Basis |
| --- | --- | --- |
| Concurrent active users (data entry) | **30–50** | Pool of 5 at ~0.9 s per write → ~5 writes/s; users act every ~30 s; queueing becomes visible past ~50. |
| Requests/s | **~5–8 sustained** | Same. |
| Database workload | trivial (20 MB) | The database is idle; the application cannot reach it fast enough. |
| Data volume | fine to ~1M rows | Indexes cover the hot paths; search and audit are the first to degrade. |
| Tolerance for a large export | **none** | One 10k-row export stalls everyone 5–15 s; one 50k export risks OOM. |

With only the database co-located (no code change): **~150–250 active users**,
then CPU and the export problem.

---

## 15. Post-fix capacity estimate

With §11 items 1–11 applied and the §12 infrastructure for each stage:

| Target | Verdict | What carries it |
| --- | --- | --- |
| **500 concurrent users** | **Yes, comfortably.** | Pool 15×4 workers, co-located DB, exports in workers, dashboard cached. Expected ~35 rps, ~650 q/s, DB CPU well under 50 %. |
| **1,000 concurrent users** | **Yes**, on 3–4 instances with PgBouncer and the trigram/audit indexes. | ~70 rps, ~1,300 q/s. Dashboard cache and the read replica keep the primary for writes. |
| **5,000 concurrent users** | **Yes, with the Stage 4 database work** (partitioned `audit_logs`, replicas, PgBouncer, export queue). | ~350 rps, ~6,000 q/s. This is ordinary territory for Postgres on 16 vCPU; the application's write chains (28–71 round trips each) are the thing to keep shortening. |

---

## 16. Final technical assessment

**Is the design sound?** Yes. The things that are hard to retrofit are already
right: row-level tenancy enforced in one place, correct row locking on document
numbers and stock, idempotency keys, optimistic locking, a real audit trail,
indexes that match the reports. Nothing here needs re-architecting.

**Is it deployed and configured for concurrency?** No. It is configured for one
developer: a five-connection pool, one process, exports on the request thread,
pure-JS bcrypt, a scheduler and rate limiter that assume a single instance, and
uploads on local disk.

**What breaks first, in order:** the connection pool (immediately, at a few
dozen writers), then the event loop (the first large export), then the CPU
(logins), then — much later — search scans and the audit table.

**What to do before putting hundreds of users on it,** in the order that buys
the most per hour of work:

1. Put the database next to the application. *(infrastructure, no code)*
2. `pool: { max: 25 }` and the two Postgres timeouts. *(one file)*
3. `REPORT_EXPORT_MAX_ROWS=10000`. *(one environment variable)*
4. Fix `cancelCounterSale` to pass its transaction through. *(mine, one file)*
5. Native `bcrypt`. *(one dependency swap)*
6. Streaming XLSX, then exports in `worker_threads`.
7. Advisory lock on the nightly job; uploads to object storage; then PM2 cluster.
8. Dashboard cache + slower poll; `audit_logs` index; trigram search indexes.

Then load-test Scenario D, read `pg_stat_statements`, and iterate.

**Missing information** that would sharpen the numbers: where and how
production is actually run (no Dockerfile/PM2/nginx config in the repo), the
production database instance size, real request logs from a working day, and
whether the database will be in the same VPC as the application.
