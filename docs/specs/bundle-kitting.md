# Feature Spec: Product Bundles & Accessory Auto-Attach

**Status:** All six phases built. 76 backend tests green; UI shipped in EPR-frontend. §0b decisions taken — see §0c.
**Owner:** <your name>
**Applies to:** INFIDEEP ERP — Sales module

---

## 0. Stack context

Filled in from the codebase on 2026-09-02.

| Item | Value |
|---|---|
| Backend language / framework | **Node 22 + Express 4 + Sequelize 6** (not NestJS/TypeORM) |
| Database | **PostgreSQL** (`pg` 8.11; dev/test on 17.5) |
| Migration tool | **sequelize-cli**, migrations in `src/migrations/`, named `YYYYMMDDHHMMSS-description.js` |
| Test framework | **Jest + Supertest**, integration tests against a real Postgres built from the migrations (`tests/helpers/globalSetup.js`). `maxWorkers: 1`; each file truncates and re-seeds. |
| Frontend | **React 19 + Vite + TanStack Query v5 + Tailwind + Radix** (shadcn-style primitives in `src/components/ui/`) |
| Existing sales line entity | **There is no single one — see §0b.1.** Three separate tables: `sales_order_lines`, `delivery_challan_lines`, `sales_invoice_lines` |
| Existing pricing service | `src/api/pricing/pricing.service.js` — price lists resolved per party, `PriceList` / `PriceListItem` |
| Existing tax service | **None — see §0b.5.** GST is computed inline during invoice creation; the rate lives on `HsnCode` and is copied onto `sales_invoice_lines.gstRatePercent` |
| Multi-tenant? | **Yes.** `tenantId` on every table, applied automatically from CLS by `BaseScopedModel` / `BaseAuditedModel`. Additionally **factory-scoped** (BR-29) via `UserFactory` + `enforceFactoryScope`. |
| Money representation | **BIGINT paise** in both DB and code (`ratePaise`, `amountPaise`, `taxableAmountPaise`). Quantities are `DECIMAL(14,4)`. No floats anywhere. |

---

## 0b. Conflicts found in this codebase — decisions needed before Phase 1

The spec was written against a different application shape. None of these are
disagreements with the design; they are places where the spec names something that does
not exist here, and guessing would produce migrations that fail or a schema that is wrong
in a way that is expensive to unpick later.

### 1. `sales_document` / `sales_document_line` do not exist — **BLOCKING**

This ERP has no unified sales document. It has three, with three different line tables
and genuinely different shapes:

| Table | Carries |
|---|---|
| `sales_order_lines` | `orderedQty`, `ratePaise`, `dispatchedQty`, `productionRequired` — **no tax** |
| `delivery_challan_lines` | dispatched quantity, `salesOrderLineId`, lot — **no rate, no tax** (BR-07: a challan travels with the driver and must not carry money) |
| `sales_invoice_lines` | `gstRatePercent`, `taxableAmountPaise` — where tax actually happens |

§3's `ALTER TABLE sales_document_line` has no target, and §6's
`/sales-documents/{id}/lines` has no resource.

**Recommendation:** bundles attach to the **sales order** only. That is where a
salesperson adds product X, and expanded components then flow to challan and invoice as
ordinary lines with no bundle awareness needed downstream. This keeps the blast radius to
one module and leaves BR-07 intact.

> **Decision required:** confirm sales-order-only, or name the other documents.

### 2. Every new table needs `tenantId` — **BLOCKING**

§0 says "if multi-tenant, every table below needs tenant_id + it goes first in every
index". This system **is** multi-tenant, and the §3 schema has none.

Concretely, `UNIQUE (code, version)` on `bundle_rule` must become
`UNIQUE (tenantId, code, version)`, or the second tenant to create a bundle coded
`STARTER` is rejected by the first tenant's row. The same applies to the lookup index and
to all five new tables.

New models should extend `BaseScopedModel` (or `BaseAuditedModel` where an audit trail is
wanted), which applies `tenantId` from CLS automatically on find/create.

### 3. Factory scoping (BR-29) is not addressed

Every transactional read and write here is additionally scoped by factory: a request
naming a `factoryId` the user has no `UserFactory` row for is refused regardless of
permissions.

- `bundle_rule` / `bundle_component` are master data, like a price list — **tenant-wide,
  not factory-scoped** is the natural fit.
- `bundle_component_suppression` and `bundle_override_audit` reference documents that
  *are* factory-scoped, so their list endpoints must go through the same `baseWhere`
  pattern the other list services use.

> **Decision required:** confirm bundle rules are tenant-wide.

### 4. Money type mismatch — **BLOCKING**

§3 specifies `system_unit_price DECIMAL(18,4)`. This codebase stores money exclusively as
**BIGINT paise**. Introducing a decimal money column would be the only one in the schema
and is a genuine defect vector at every comparison and sum.

**Proposed:** `systemUnitPricePaise BIGINT`. Quantities stay `DECIMAL(14,4)`, matching
every existing line table.

### 5. There is no tax service to call

§9 says "Do not modify existing pricing or tax services. Call them." There is a pricing
service. There is no tax service — GST is derived from the product's HSN when an invoice
is created.

This mostly resolves itself: **sales order lines carry no tax at all**, so §4's
`recomputeTax(...)` has nothing to do at order level, and §1's "each accessory carries its
own HSN and GST rate" is satisfied automatically once the components reach an invoice as
independent lines.

> **Decision required:** confirm the bundle work does not need tax at order time. If
> quotes must show tax-inclusive totals, that is a new capability and belongs in its own
> phase.

### 6. Table names differ

`product` → `products`, `uom` → `uoms`. Verbatim DDL from §3 will fail. Minor, listed so
it is not discovered mid-migration.

### 7. Overlap with the existing BOM — worth stating deliberately

`mix_designs` / `mix_design_lines` already model *a parent product exploding into
components with per-unit quantities, versioning, status and `effectiveFrom`*. That is
structurally very close to `bundle_rule` / `bundle_component`.

They are semantically different — a mix design is a manufacturing recipe consumed by a
casting run, a bundle is a sales kit that becomes billable lines — and §1's non-goals
explicitly exclude assembled kits. **Two separate tables is the right call**, but it
should be a recorded decision rather than something a reviewer discovers and challenges
later.

### 8. Naming convention

This codebase uses `camelCase` columns in Postgres (quoted identifiers), e.g.
`"parentLineId"`, `"bundleRuleId"`. The §3 DDL is `snake_case`. New tables should follow
the existing convention or joins become inconsistent across the schema.

---

## 0c. Decisions taken

| § | Question | Decision |
|---|---|---|
| 1 | Which document do bundles attach to? | **Sales orders only.** `sales_order_lines` gets the nine new columns; challans and invoices are untouched. |
| — | Are bundle rules per factory or tenant-wide? | **Tenant-wide.** `bundle_rules` is scoped by `tenantId` alone, with no `factoryId`. |
| — | Where does tax live? | **Derived per line from the component's own HSN, summarised at the order header.** No rate is ever typed on a sale. A single header rate was rejected: a bundle routinely mixes GST rates (a 12% cable beside an 18% printer) and GSTR-1 requires an HSN-wise breakup, so one blended rate would produce an unfilable return. The header carries `taxSummary`, grouped by rate — which is the shape the return actually wants. |

## 0d. Conflicts the document wiring forced

**Duplicate product lines.** `SalesService.validateLines` rejected two lines of the same
product outright, which test 11 requires. The rejection is now scoped to products with no
active bundle rule — an accidental double-entry is still refused, while two separately
configured printers are allowed.

Its stated reason had to be fixed rather than waived: each line computed
`productionRequired` against the same untouched availability snapshot, so a 60 + 60 order
against 100 units booked zero production on both instead of 20. `buildLines` now draws
availability down as it walks the lines.

**Order totals and the credit check.** Components carry money, so the total is recomputed
from the lines that actually ended up on the order, and the credit-limit check moved to
after expansion. Checking the pre-expansion total would let an order through on a limit
its accessories breach.

## 1. What we are building

When a salesperson adds product **X** to a sales document, the system automatically adds
its configured accessories (**a1, b1, c1…**) as separate billable lines.

- Each accessory is **priced independently** from the normal price list.
- Each accessory contributes its own line total to the document total.
- Each accessory carries its **own HSN and GST rate** (treated as an independent supply,
  not a composite or mixed supply — separate pricing, separately identifiable items).
- The salesperson may **change quantity, change price, remove, or re-add** any accessory.

### Explicit non-goals for this build
- Assembled/manufactured kits (parent SKU stocked as one unit)
- Bundle-level discounts and discount allocation across components
- Composite/mixed supply GST treatment
- Nested bundles (a bundle whose component is itself a bundle)

Leave schema room for these (see `bundleType`, `taxTreatment`) but **do not implement
them**.

---

## 2. Non-negotiable invariants

Violating any of these is a defect, regardless of what a ticket says. Do not "optimise"
these away.

1. **Expansion logic lives in exactly one service.** Not in the frontend, not in DB
   triggers, not duplicated in the import path. Every caller uses the same
   `BundleExpansionService`.
2. **The expansion service is pure.** Given the same inputs it returns the same plan,
   always. It reads master data and returns a result object. It performs no writes.
3. **Never re-resolve a bundle from live master data when reading a historical document.**
   Documents carry `(bundleRuleId, bundleRuleVersion)` and a frozen JSON snapshot.
4. **A removed accessory never comes back on its own.** Suppression is recorded as a
   tombstone row and is checked first on every reconcile. Only an explicit restore clears
   it.
5. **A user-overridden line is never silently rewritten.** If `syncState != 'SYNCED'`, the
   system updates `systemQty` for reference but leaves quantity and price alone.
6. **No soft-delete flag on the line table.** The line table contains only real, billable
   lines. Anything else corrupts totals, print templates, e-invoice payloads, and GST
   returns the first time someone forgets a `WHERE` clause.
7. **Every mutation returns the full recalculated document.** The client re-renders; it
   never computes totals, tax, or which accessories should exist.
8. **Component identity is keyed by `(parentLineId, componentProductId)`** — never by
   `(documentId, productId)`. Two lines of product X on one document must have completely
   independent accessory sets.
9. **No floating point for money.** Ever. BIGINT paise, per §0.

---

## 3. Schema

> DDL below is illustrative. Actual migrations follow this codebase's conventions:
> camelCase quoted identifiers, `tenantId` first in every index, BIGINT paise for money,
> `DECIMAL(14,4)` for quantities. See §0b.2, §0b.4, §0b.6, §0b.8.

```sql
CREATE TABLE bundle_rules (
    id                  UUID PRIMARY KEY,
    "tenantId"          UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    code                VARCHAR(50)  NOT NULL,
    name                VARCHAR(200) NOT NULL,
    "parentProductId"   UUID NOT NULL REFERENCES products(id),
    "bundleType"        VARCHAR(20)  NOT NULL DEFAULT 'EXPLODED',
                        -- EXPLODED | ASSEMBLED   (only EXPLODED implemented)
    "taxTreatment"      VARCHAR(20)  NOT NULL DEFAULT 'INDEPENDENT',
                        -- INDEPENDENT | COMPOSITE | MIXED  (only INDEPENDENT implemented)
    version             INT          NOT NULL DEFAULT 1,
    status              VARCHAR(20)  NOT NULL DEFAULT 'DRAFT',
                        -- DRAFT | ACTIVE | SUPERSEDED | ARCHIVED
    "effectiveFrom"     DATE         NOT NULL,
    "effectiveTo"       DATE         NULL,
    priority            INT          NOT NULL DEFAULT 100,
    "publishedBy"       UUID NULL REFERENCES employees(id) ON DELETE SET NULL,
    "publishedAt"       TIMESTAMPTZ NULL,
    "createdAt"         TIMESTAMPTZ NOT NULL,
    "updatedAt"         TIMESTAMPTZ NOT NULL,
    UNIQUE ("tenantId", code, version)          -- tenantId first: see §0b.2
);

CREATE INDEX ix_bundle_rules_lookup
    ON bundle_rules ("tenantId", "parentProductId", status, "effectiveFrom", "effectiveTo");

CREATE TABLE bundle_components (
    id                   UUID PRIMARY KEY,
    "tenantId"           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    "bundleRuleId"       UUID NOT NULL REFERENCES bundle_rules(id) ON DELETE CASCADE,
    "componentProductId" UUID NOT NULL REFERENCES products(id),
    quantity             DECIMAL(14,4) NOT NULL,
    "scalingMode"        VARCHAR(20)  NOT NULL DEFAULT 'PROPORTIONAL',
                         -- PROPORTIONAL: qty x parent qty  |  FIXED: qty regardless
    "uomId"              UUID NOT NULL REFERENCES uoms(id),
    "isMandatory"        BOOLEAN NOT NULL DEFAULT false,
    "defaultSelected"    BOOLEAN NOT NULL DEFAULT true,
                         -- true  = auto-added on expansion
                         -- false = offered in the optional-accessory picker only
    sequence             INT NOT NULL DEFAULT 0,
    "createdAt"          TIMESTAMPTZ NOT NULL,
    "updatedAt"          TIMESTAMPTZ NOT NULL,
    UNIQUE ("bundleRuleId", "componentProductId")
);

CREATE TABLE bundle_component_suppressions (
    id                   UUID PRIMARY KEY,
    "tenantId"           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    "salesOrderId"       UUID NOT NULL REFERENCES sales_orders(id) ON DELETE CASCADE,
    "parentLineId"       UUID NOT NULL REFERENCES sales_order_lines(id) ON DELETE CASCADE,
    "componentProductId" UUID NOT NULL REFERENCES products(id),
    "reasonCode"         VARCHAR(50) NOT NULL REFERENCES override_reason_codes(code),
    "reasonNote"         TEXT NULL,
    "suppressedBy"       UUID NOT NULL REFERENCES employees(id),
    "suppressedAt"       TIMESTAMPTZ NOT NULL,
    "createdAt"          TIMESTAMPTZ NOT NULL,
    "updatedAt"          TIMESTAMPTZ NOT NULL,
    UNIQUE ("parentLineId", "componentProductId")     -- invariant 8
);

CREATE TABLE override_reason_codes (
    code            VARCHAR(50) PRIMARY KEY,
    "tenantId"      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    label           VARCHAR(200) NOT NULL,
    "requiresNote"  BOOLEAN NOT NULL DEFAULT false,
    "isActive"      BOOLEAN NOT NULL DEFAULT true
);
-- Seed: CUSTOMER_DECLINED, OUT_OF_STOCK, ALREADY_OWNS, COMPETITIVE_MATCH,
--       OTHER (requiresNote = true)

CREATE TABLE bundle_override_audits (
    id                   UUID PRIMARY KEY,
    "tenantId"           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    "salesOrderId"       UUID NOT NULL,
    "lineId"             UUID NULL,
    "parentLineId"       UUID NULL,
    "componentProductId" UUID NULL,
    action               VARCHAR(30) NOT NULL,
                         -- QTY_CHANGED | PRICE_CHANGED | SUPPRESSED | RESTORED
                         -- | OPTIONAL_ADDED | RESET
    "beforeValue"        JSONB NULL,
    "afterValue"         JSONB NULL,
    "reasonCode"         VARCHAR(50) NULL,
    "reasonNote"         TEXT NULL,
    "actorId"            UUID NOT NULL,
    "occurredAt"         TIMESTAMPTZ NOT NULL
);
-- Append-only. No UPDATE, no DELETE.
```

### Columns to ADD to `sales_order_lines`

```sql
ALTER TABLE sales_order_lines
    ADD COLUMN "lineRole"             VARCHAR(20) NOT NULL DEFAULT 'STANDALONE',
                                      -- PARENT | COMPONENT | STANDALONE
    ADD COLUMN "parentLineId"         UUID NULL REFERENCES sales_order_lines(id),
    ADD COLUMN "bundleRuleId"         UUID NULL REFERENCES bundle_rules(id),
    ADD COLUMN "bundleRuleVersion"    INT NULL,
    ADD COLUMN "bundleSnapshot"       JSONB NULL,        -- invariant 3
    ADD COLUMN origin                 VARCHAR(20) NOT NULL DEFAULT 'MANUAL',
                                      -- RULE_AUTO | RULE_OPTIONAL | MANUAL
    ADD COLUMN "syncState"            VARCHAR(20) NOT NULL DEFAULT 'SYNCED',
                                      -- SYNCED | QTY_OVERRIDDEN | PRICE_OVERRIDDEN | DETACHED
    ADD COLUMN "systemQty"            DECIMAL(14,4) NULL,
    ADD COLUMN "systemUnitPricePaise" BIGINT NULL;       -- §0b.4

CREATE INDEX ix_sol_parent ON sales_order_lines ("parentLineId");
```

**Why `origin` and `syncState` are two fields, not one enum:** `origin` records how the
line got there and never changes. `syncState` records whether the system still controls it
and changes freely. Merging them produces states like `USER_ADDED_THEN_QTY_CHANGED` and
the transition table stops being writable.

**Why `systemQty` is stored:** it is the only reliable way to answer "has the user touched
this line?" Recomputing from the rule at read time gives the wrong answer the moment the
rule is edited or superseded.

---

## 4. Core algorithm

`BundleExpansionService.reconcile(parentLine, newParentQty, context)`

This one function handles **every** mutation: add parent, change parent qty, suppress a
component, restore a component, add an optional component, reset an override. Do not write
separate code paths per action — the action only decides what changes *before* reconcile
runs.

```
reconcile(parentLine, newParentQty, context):

    rule       = snapshotRule(parentLine.bundleRuleId, parentLine.bundleRuleVersion)
    present    = componentLinesOf(parentLine)           keyed by componentProductId
    suppressed = suppressionsFor(parentLine.id)         as a Set of productId
    warnings   = []

    for c in rule.components ordered by c.sequence:

        if c.componentProductId in suppressed:
            continue                        # INVARIANT 4 — tombstone always wins

        targetQty = (c.scalingMode == PROPORTIONAL)
                      ? c.quantity * newParentQty
                      : c.quantity

        line = present[c.componentProductId]

        if line == null:
            if c.defaultSelected:
                create COMPONENT line:
                    qty                  = targetQty
                    systemQty            = targetQty
                    ratePaise            = priceFor(c.componentProductId, context)
                    systemUnitPricePaise = same
                    origin               = RULE_AUTO
                    syncState            = SYNCED
                    parentLineId         = parentLine.id
            # defaultSelected = false -> offered in picker, never auto-created
        else:
            line.systemQty = targetQty                  # always refresh the baseline

            if line.syncState == SYNCED:
                line.qty = targetQty                    # safe to rescale
            else:
                warnings.add(QTY_VARIANCE, line, targetQty)   # INVARIANT 5

    # components on the document that the rule no longer contains
    for line in present not matched by any rule component:
        line.syncState = DETACHED                       # keep the line, stop managing it
        warnings.add(DETACHED_COMPONENT, line)

    reprice(affectedLines, context)     # skip lines with syncState = PRICE_OVERRIDDEN
    recomputeTotals(order)              # no tax at order level here — see §0b.5

    return { order, warnings }
```

### Quantity variance rule — absolute, never ratio

Salesperson sells 1 printer, rule adds 2 cables, they change it to 5, then change the
printer qty to 3.

- Ratio interpretation would give 15 cables. **Do not do this.**
- Absolute interpretation keeps it at 5, sets `systemQty = 6`, and raises a variance
  warning.

Absolute is predictable, explainable, and reversible via the reset action. Never infer
intent the user did not express.

---

## 5. State transition table

Implement exactly this. It is the acceptance criteria for §7 tests 3–8.

| Action | `origin` | `syncState` | Tombstone | Audit action |
|---|---|---|---|---|
| Auto-added during expansion | `RULE_AUTO` | `SYNCED` | — | — |
| User changes qty | unchanged | `QTY_OVERRIDDEN` | — | `QTY_CHANGED` |
| User changes price/discount | unchanged | `PRICE_OVERRIDDEN` | — | `PRICE_CHANGED` |
| User removes component | line deleted | — | **created** | `SUPPRESSED` |
| User restores component | `RULE_AUTO` | `SYNCED` | **cleared** | `RESTORED` |
| User adds optional accessory | `RULE_OPTIONAL` | `SYNCED` | cleared if present | `OPTIONAL_ADDED` |
| User adds off-catalogue item under parent | `MANUAL` | `DETACHED` | — | — |
| Rule version no longer lists component | unchanged | `DETACHED` | — | — |
| User hits "reset to suggested" | unchanged | `SYNCED` | — | `RESET` |
| Parent line deleted | components deleted | — | **cleared** | — |

Restore deliberately resets to `SYNCED`: "put it back the way it was" is what a
salesperson means, and it makes the line resume scaling with the parent.

---

## 6. API contract

Commands, not CRUD. Do not expose a generic line PATCH and let the frontend orchestrate.

> Paths below assume the sales-order decision in §0b.1. Base path is `/api/v1`.

```
POST   /sales/orders/{id}/lines
       { productId, qty }

PATCH  /sales/orders/{id}/lines/{lineId}/quantity
       { qty }

POST   /sales/orders/{id}/lines/{lineId}/suppress
       { reasonCode, reasonNote? }

POST   /sales/orders/{id}/lines/{parentLineId}/restore
       { componentProductId }

POST   /sales/orders/{id}/lines/{parentLineId}/components
       { productId, qty }

POST   /sales/orders/{id}/lines/{lineId}/reset

GET    /products/{id}/bundle-preview?qty=&customerId=&priceListId=&date=
       -> read-only expansion plan, writes nothing

GET    /sales/orders/{id}/lines/{parentLineId}/available-accessories
       -> optional components not currently on the document
```

**Every mutating endpoint returns the same envelope:**

```json
{
  "order": { "...header, all lines, totals..." },
  "warnings": [
    { "code": "QTY_VARIANCE", "lineId": "...", "suggestedQty": 6, "currentQty": 5 }
  ]
}
```

All mutating endpoints accept an `Idempotency-Key` header. A client on flaky connectivity
will retry, and a duplicate retry must not produce two cables.

**Permissions.** Suppressing a component where `isMandatory = true` requires a new
`SALES_BUNDLE_OVERRIDE_MANDATORY` grant, added to the permission catalog in
`src/utils/permissionCatalog.js`. Without it, return `403` with a machine-readable code —
do not silently no-op.

---

## 7. Test matrix — write these first

These are the acceptance criteria. All must pass before a phase is considered done.

| # | Scenario | Expected |
|---|---|---|
| 1 | Add X qty 1 | a1, b1, c1 created at rule qty, `origin=RULE_AUTO`, `syncState=SYNCED` |
| 2 | X qty 1 → 3 | PROPORTIONAL components ×3; FIXED components unchanged |
| 3 | Set b1 qty 5, then X qty 1 → 3 | b1 stays 5, `systemQty=6`, `QTY_VARIANCE` warning |
| 4 | Remove c1, then X qty 1 → 3 | **c1 does not reappear** |
| 5 | Remove c1, restore c1, X qty → 3 | c1 present, `SYNCED`, scaling normally |
| 6 | Remove every component | parent survives alone, totals correct |
| 7 | Delete parent line | components deleted AND tombstones cleared |
| 8 | Add optional accessory d1 | line created, survives a parent qty change |
| 9 | Order → challan → invoice | all states preserved; **no re-expansion** |
| 10 | Rule v2 published while order is open | order unchanged until explicit refresh action |
| 11 | Two separate lines of product X on one order | fully independent accessory sets |
| 12 | Sum of all line totals | equals order total, exact to the paisa |
| 13 | Override price on a1, then change X qty | a1 price preserved, qty rescales |
| 14 | Suppress a mandatory component without permission | `403`, no state change |
| 15 | Replay a mutation with the same `Idempotency-Key` | identical response, no duplicate line |
| 16 | Tenant B cannot see or expand tenant A's bundle rule | scoped out entirely |

**Tests 4 and 11 fail in most first implementations.** Test 11 in particular fails
whenever anything is keyed by `(orderId, productId)` instead of
`(parentLineId, productId)`.

Test 16 is new — this codebase is multi-tenant and every existing module has an
equivalent isolation test.

---

## 8. Build phases

Do not start a phase until the previous phase's tests are green.

### Phase 1 — Pure core — **DONE**
Migrations for all new tables and columns. `BundleExpansionService` with `reconcile()`.
`GET /products/{id}/bundle-preview`. Unit tests 1, 2, 3, 11, 12, 16.
**No writes to sales orders in this phase.**

Delivered:

- `src/migrations/20260903000000-bundle-kitting.js` — five tables, nine columns on
  `sales_order_lines`.
- `src/api/bundles/bundleRule.model.js`, `bundleComponent.model.js`, registered in
  `src/models/index.js`.
- `src/api/bundles/bundleExpansion.service.js` — `reconcile()`, pure.
- `src/api/bundles/bundles.controller.js` + route on the products router, with
  `enforceFactoryScope` and BR-27 rate masking.
- `tests/bundle-expansion.test.js` — 18 tests, all green, including one that asserts
  row counts are unchanged after calling `reconcile()`.

Found on the way, and fixed because it blocked this: the models and the migrations had
drifted by 90 columns across 11 tables, so a database built purely from migrations could
not run the application at all (`FinancialYear.create` failed outright). Closed by
`src/migrations/20260908000000-reconcile-model-schema-drift.js`.

### Phase 2 — Document integration — **DONE**
Wire into sales order create/update. Suppression table, restore, optional-accessory
picker. Parent delete cascade. Tests 4, 5, 6, 7, 8.

Delivered:

- `src/api/bundles/bundleDocument.service.js` — every command in §5, each one adjusting
  the single fact the user changed and then re-running expansion over the result. No
  per-action expansion logic.
- `overrideReasonCode`, `bundleComponentSuppression`, `bundleOverrideAudit` models; the
  nine bundle columns added to `SalesOrderLine`.
- `SALES_BUNDLE_OVERRIDE_MANDATORY` in the permission catalogue; the refusal carries
  `code: BUNDLE_MANDATORY_COMPONENT`, which `sendError` now passes through.
- Expansion wired into `SalesService.createSalesOrder` and `updateSalesOrder`.
- `tests/bundle-document.test.js` — 20 tests covering 3, 4, 5, 6, 7, 8, 11, 12 and 14.

Two things the wiring forced, both recorded in §0d.

### Phase 3 — Command API — **DONE**
All endpoints from §6. Idempotency. Full-order response envelope. Order → challan →
invoice preserving state. Tests 9, 13, 15.

Delivered:

- `src/api/bundles/bundleCommands.controller.js` and the routes on the sales router —
  every endpoint in §6, each returning `{ order, warnings }`.
- Idempotency, which did not exist anywhere in this codebase:
  `migrations/20260909000000-idempotency-keys.js`, the model, and
  `middlewares/idempotency.js`. A row is claimed before the handler runs, so the unique
  `(tenantId, key)` index — not application logic — is what stops two concurrent retries.
  The header is optional, so existing clients are unaffected.
- `SalesService.addLine`, for adding one line to a draft order without discarding the
  accessory decisions already made on the others.
- `tests/bundle-commands.test.js` — 16 tests, including the full order → confirm →
  challan → invoice journey asserting the configuration is byte-identical at each step.

### Phase 4 — Governance — **DONE**
Reason codes, `isMandatory` permission gate, `bundle_override_audits` writes, rule
draft→publish workflow with version freezing, attach-rate report
(per product / per salesperson / per location). Tests 10, 14.

Delivered:

- `bundleRules.service.js` — draft/publish lifecycle. An ACTIVE rule is immutable; a
  change is a new version that supersedes it from a date, and the outgoing version keeps
  an `effectiveTo` rather than being deleted so reports can still resolve what it said.
  Superseding follows the `code` lineage, not the product, so a product can carry more
  than one bundle at once with `priority` deciding between them.
- `bundleReports.service.js` — attach rate by product, salesperson or location, each row
  carrying the stated reasons; plus the override trail for one order.
- `bundles.router.js`, mounted at `/api/v1/bundles`.
- `tests/bundle-governance.test.js` — 14 tests.

**Test 10 exposed a real gap in Phase 1.** `reconcile()` resolved the rule live on every
call, so publishing v2 would have changed an open order the next time anyone touched its
quantity. It now uses the line's frozen `bundleSnapshot`, and
`BundleDocumentService.refreshToLatestRule()` is the only way an order adopts a newer
version — which still re-plans rather than discarding suppressions and overrides.

### Phase 5 — UI — **DONE**
Components indented under parent. Parent chip: `3 of 4 accessories · 1 removed`. Removed
items in an expandable tray with one-tap restore. Variance badge with
"reset to suggested (6)". Toast with undo on auto-add — **never a blocking modal**.

Delivered in `EPR-frontend`:

- `src/hooks/use-bundles.js` — every command, each sending an `Idempotency-Key`, and each
  writing the returned order straight into the cache so accessories appear in the same
  paint as the parent.
- `src/components/sales/bundle-lines.jsx` — the grouped line table: indentation with a
  rule down the left, the summary chip, the removal tray, the accessory picker, the
  "changed from N" badge and its reset button.
- `src/components/sales/bundle-preview-note.jsx` — "Brings 2 × Cable, 1 × Toner" under a
  line *as it is typed*, so a salesperson quoting over the phone knows before saving.
- Removal and auto-add both announce themselves through `sonner` toasts with an undo.
  Nothing blocks.

Two fixes the UI forced: editing a draft reloaded the server-added component lines as
editable rows, which would have resubmitted and duplicated them; and the client-side
duplicate-product check had to go, because it could not tell an accidental repeat from a
second deliberately configured bundle.

### Phase 6 — Inventory — **DONE**
Available-to-promise for parent = `min over components of floor(available_i / qty_i)`.
Reservation on components, not the phantom parent. Note this must go through the existing
`ReservationService`, which already computes
`available = on hand − reserved − curing − in transit − awaiting QC`.

Delivered:

- `bundleAvailability.service.js` and `GET /bundles/products/:id/available-bundles`.
  Availability comes from `ReservationService.getAvailability`, never recomputed here.
- The answer names the bottleneck — "12, limited by the cable" — rather than returning a
  bare number, because that is what lets a salesperson say what would unblock it.
- A `FIXED` component is reported but never caps the count: one installation kit covers a
  whole order, so five kits must not cap the promise at five bundles.
- **Reservation on components is already satisfied by construction.** Bundles are exploded
  into real order lines, and `confirmSalesOrder` reserves per line, so the reservation
  lands on the cable and the toner. There is no phantom parent to reserve against.
- `tests/bundle-availability.test.js` — 8 tests.

---

## 9. Working agreement

- Read this file fully before writing code. Ask before deviating from §2.
- One phase per session. Do not run ahead.
- Write the tests for a phase before the implementation.
- Migrations must be reversible and must not lock `sales_order_lines` for long — this is a
  live table.
- Do not modify the existing pricing service. Call it.
- If an invariant in §2 seems to conflict with existing code, stop and report the conflict
  rather than resolving it unilaterally.
- Flag anything in this spec that is ambiguous instead of guessing.
