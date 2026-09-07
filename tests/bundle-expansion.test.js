/**
 * Bundle expansion — Phase 1 acceptance criteria.
 * docs/specs/bundle-kitting.md §7, tests 1, 2, 3, 11, 12, 16.
 *
 * Phase 1 is the PURE core: reconcile() reads master data and returns a plan.
 * It writes nothing. Every test here asserts on the returned plan, and the last
 * one asserts the database is still untouched afterwards — invariant 2 is the
 * thing most likely to be quietly broken by a later "small" change.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, Party,
  PriceList, PriceListItem, SalesOrder, SalesOrderLine,
} = require('../src/models/index');
const { BundleRule } = require('../src/api/bundles/bundleRule.model');
const { BundleComponent } = require('../src/api/bundles/bundleComponent.model');
const { BundleExpansionService } = require('../src/api/bundles/bundleExpansion.service');
const { runInTenantContext } = require('./helpers/tenant');

let tenantId;
let otherTenantId;
let factory;
let printer;   // parent product X
let cable;     // a1 — PROPORTIONAL
let toner;     // b1 — PROPORTIONAL
let kit;       // c1 — FIXED
let manual;    // d1 — optional, defaultSelected = false
let customer;
let rule;
let adminCookie;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

/** The plan entry for a product, or undefined. */
const entryFor = (plan, productId) => plan.components.find((c) => c.componentProductId === productId);

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bundle Co', slug: 'bundle-co', status: 'active' });
  tenantId = tenant.id;
  const other = await Tenant.create({ name: 'Rival Co', slug: 'rival-co', status: 'active' });
  otherTenantId = other.id;

  const org = await Organization.create({ tenantId, name: 'Bundle Co Ltd', code: 'BC' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Bundle Plant', code: 'BC-FAC', varianceThresholdPercent: 5 });
  await User.create(
    { tenantId, email: 'admin@bundle.co', passwordHash: await bcrypt.hash('password123', 10), firstName: 'A', lastName: 'B', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-BC' });

  // Two GST rates on purpose: a single header rate cannot represent this, which
  // is why tax is computed per line and only summarised at the header.
  const hsn18 = await HsnCode.create({ tenantId, code: '8443', description: 'Printers', gstRatePercent: 18 });
  const hsn12 = await HsnCode.create({ tenantId, code: '8544', description: 'Cables', gstRatePercent: 12 });

  printer = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Printer X', code: 'FG-PRN-X', productType: 'FINISHED_GOOD' });
  cable = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn12.id, name: 'Cable a1', code: 'AC-CAB', productType: 'FINISHED_GOOD' });
  toner = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Toner b1', code: 'AC-TNR', productType: 'FINISHED_GOOD' });
  kit = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Install kit c1', code: 'AC-KIT', productType: 'FINISHED_GOOD' });
  manual = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn12.id, name: 'Manual d1', code: 'AC-MAN', productType: 'FINISHED_GOOD' });

  customer = await Party.create({ tenantId, name: 'Bundle Customer', code: 'C-BC', partyType: 'CUSTOMER', status: 'active' });

  // Retail price list — resolveRate falls back to this when the party has none.
  const pl = await PriceList.create({ tenantId, name: 'Retail', priceType: 'RETAIL', status: 'active' });
  for (const [product, paise] of [[printer, 5000000], [cable, 25000], [toner, 450000], [kit, 120000], [manual, 15000]]) {
    await PriceListItem.create({ tenantId, priceListId: pl.id, productId: product.id, ratePaise: paise });
  }

  rule = await BundleRule.create({
    tenantId, code: 'PRN-X-KIT', name: 'Printer X starter kit', parentProductId: printer.id,
    status: 'ACTIVE', effectiveFrom: '2026-04-01', version: 1,
  });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: cable.id, quantity: 2, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 1 });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: toner.id, quantity: 1, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 2 });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: kit.id, quantity: 1, scalingMode: 'FIXED', uomId: uom.id, sequence: 3 });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: manual.id, quantity: 1, scalingMode: 'FIXED', uomId: uom.id, defaultSelected: false, sequence: 4 });

  adminCookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@bundle.co', password: 'password123' }),
    'accessToken'
  );
});

afterAll(async () => {
  await sequelize.close();
});

const plan = (opts) =>
  runInTenantContext(tenantId, () =>
    BundleExpansionService.reconcile({
      parentProductId: printer.id,
      parentLineId: opts.parentLineId || 'line-1',
      newParentQty: opts.qty,
      presentComponents: opts.present || [],
      suppressedProductIds: opts.suppressed || [],
      context: { factoryId: factory.id, partyId: customer.id, onDate: '2026-08-01' },
    })
  );

describe('Test 1 — add X qty 1', () => {
  it('creates the default-selected components at rule quantity', async () => {
    const p = await plan({ qty: 1 });

    // manual (defaultSelected false) is offered, never auto-added.
    const created = p.components.filter((c) => c.action === 'CREATE');
    expect(created.map((c) => c.componentProductId).sort()).toEqual([cable.id, toner.id, kit.id].sort());

    for (const c of created) {
      expect([c.componentProductId, c.origin]).toEqual([c.componentProductId, 'RULE_AUTO']);
      expect([c.componentProductId, c.syncState]).toEqual([c.componentProductId, 'SYNCED']);
      expect([c.componentProductId, c.qty]).toEqual([c.componentProductId, c.systemQty]);
    }

    expect(entryFor(p, cable.id).qty).toBe(2);
    expect(entryFor(p, toner.id).qty).toBe(1);
    expect(entryFor(p, kit.id).qty).toBe(1);
    expect(p.optional.map((o) => o.componentProductId)).toEqual([manual.id]);
  });

  it('freezes the rule on the plan so a historical line never re-resolves', () => {
    // Invariant 3: the snapshot travels with the line.
    return plan({ qty: 1 }).then((p) => {
      expect(p.bundleRuleId).toBe(rule.id);
      expect(p.bundleRuleVersion).toBe(1);
      expect(p.snapshot.components).toHaveLength(4);
      expect(p.snapshot.code).toBe('PRN-X-KIT');
    });
  });
});

describe('Test 2 — X qty 1 to 3', () => {
  it('scales PROPORTIONAL components and leaves FIXED alone', async () => {
    const p = await plan({ qty: 3 });
    expect(entryFor(p, cable.id).qty).toBe(6); // 2 x 3
    expect(entryFor(p, toner.id).qty).toBe(3); // 1 x 3
    expect(entryFor(p, kit.id).qty).toBe(1);   // FIXED
  });
});

describe('Test 3 — a user override is never silently rewritten', () => {
  it('keeps the overridden quantity, refreshes systemQty, and warns', async () => {
    const p = await plan({
      qty: 3,
      present: [
        { componentProductId: toner.id, lineId: 'l-toner', qty: 5, systemQty: 1, syncState: 'QTY_OVERRIDDEN', origin: 'RULE_AUTO', unitPricePaise: 450000 },
      ],
    });

    const t = entryFor(p, toner.id);
    // Absolute, never ratio: 5 stays 5. A ratio reading would give 15.
    expect(t.qty).toBe(5);
    expect(t.systemQty).toBe(3);
    expect(t.syncState).toBe('QTY_OVERRIDDEN');
    expect(t.action).toBe('UPDATE');

    const w = p.warnings.find((x) => x.code === 'QTY_VARIANCE' && x.componentProductId === toner.id);
    expect(w).toBeDefined();
    expect(w.suggestedQty).toBe(3);
    expect(w.currentQty).toBe(5);
  });

  it('leaves a price override alone while still rescaling quantity', async () => {
    const p = await plan({
      qty: 3,
      present: [
        { componentProductId: cable.id, lineId: 'l-cable', qty: 2, systemQty: 2, syncState: 'PRICE_OVERRIDDEN', origin: 'RULE_AUTO', unitPricePaise: 19999 },
      ],
    });

    const c = entryFor(p, cable.id);
    expect(c.unitPricePaise).toBe(19999);          // untouched
    expect(c.systemUnitPricePaise).toBe(25000);    // list price, for reference
    expect(c.qty).toBe(6);                         // quantity still rescales
  });
});

describe('Test 11 — two lines of the same product are independent', () => {
  it('keys component identity by parent line, not by product', async () => {
    const first = await plan({ qty: 1, parentLineId: 'line-A' });
    const second = await plan({
      qty: 2,
      parentLineId: 'line-B',
      suppressed: [cable.id],   // suppressed on B only
    });

    expect(entryFor(first, cable.id)).toBeDefined();
    expect(entryFor(second, cable.id)).toBeUndefined();
    expect(entryFor(second, toner.id).qty).toBe(2);
    expect(first.parentLineId).toBe('line-A');
    expect(second.parentLineId).toBe('line-B');
  });
});

describe('Test 12 — money is exact to the paisa', () => {
  it('sums line totals to the plan total with no drift', async () => {
    const p = await plan({ qty: 3 });

    const summed = p.components
      .filter((c) => c.action !== 'DETACH')
      .reduce((acc, c) => acc + c.lineTotalPaise, 0);
    expect(summed).toBe(p.totals.componentsTotalPaise);

    // Every money figure is an integer number of paise. A float would surface
    // here as a fractional value long before it surfaced on an invoice.
    for (const c of p.components) {
      expect(Number.isInteger(c.unitPricePaise)).toBe(true);
      expect(Number.isInteger(c.taxableAmountPaise)).toBe(true);
      expect(Number.isInteger(c.taxPaise)).toBe(true);
      expect(Number.isInteger(c.lineTotalPaise)).toBe(true);
    }
    expect(Number.isInteger(p.totals.componentsTotalPaise)).toBe(true);
    expect(p.totals.taxableAmountPaise + p.totals.taxPaise).toBe(p.totals.componentsTotalPaise);
  });

  it('derives each rate from the component HSN, never a single header rate', async () => {
    const p = await plan({ qty: 1 });

    // cable is 12%, toner and kit are 18% — a header rate cannot express this.
    expect(entryFor(p, cable.id).gstRatePercent).toBe(12);
    expect(entryFor(p, toner.id).gstRatePercent).toBe(18);

    const c = entryFor(p, cable.id);
    expect(c.taxableAmountPaise).toBe(50000);              // 2 x 25000
    expect(c.taxPaise).toBe(6000);                         // 12% of 50000
    expect(c.lineTotalPaise).toBe(56000);

    // The header summary groups by rate, which is what GSTR-1 needs.
    const rates = p.totals.taxSummary.map((s) => s.gstRatePercent).sort((a, b) => a - b);
    expect(rates).toEqual([12, 18]);
  });
});

describe('Test 16 — a bundle rule never crosses a tenant', () => {
  it('does not resolve another tenant’s rule', async () => {
    const p = await runInTenantContext(otherTenantId, () =>
      BundleExpansionService.reconcile({
        parentProductId: printer.id,
        parentLineId: 'line-x',
        newParentQty: 1,
        presentComponents: [],
        suppressedProductIds: [],
        context: { factoryId: factory.id, partyId: customer.id, onDate: '2026-08-01' },
      })
    );

    expect(p.bundleRuleId).toBeNull();
    expect(p.components).toEqual([]);
  });
});

describe('Invariant 2 — the service is pure', () => {
  it('returns the same plan for the same inputs', async () => {
    const a = await plan({ qty: 4 });
    const b = await plan({ qty: 4 });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('writes nothing at all', async () => {
    const before = {
      lines: await SalesOrderLine.count(),
      orders: await SalesOrder.count(),
      rules: await BundleRule.count(),
      components: await BundleComponent.count(),
    };

    await plan({ qty: 7 });
    await plan({ qty: 2, suppressed: [kit.id] });

    expect({
      lines: await SalesOrderLine.count(),
      orders: await SalesOrder.count(),
      rules: await BundleRule.count(),
      components: await BundleComponent.count(),
    }).toEqual(before);
  });
});

describe('rule resolution by date', () => {
  it('ignores a rule that is not yet effective', async () => {
    const p = await runInTenantContext(tenantId, () =>
      BundleExpansionService.reconcile({
        parentProductId: printer.id,
        parentLineId: 'line-early',
        newParentQty: 1,
        presentComponents: [],
        suppressedProductIds: [],
        context: { factoryId: factory.id, partyId: customer.id, onDate: '2026-01-01' },
      })
    );
    expect(p.bundleRuleId).toBeNull();
  });

  it('ignores a DRAFT rule', async () => {
    await rule.update({ status: 'DRAFT' });
    const p = await plan({ qty: 1 });
    expect(p.bundleRuleId).toBeNull();
    await rule.update({ status: 'ACTIVE' });
  });
});

describe('GET /products/:id/bundle-preview', () => {
  const preview = (productId, query = '') =>
    request(app)
      .get(`/api/v1/products/${productId}/bundle-preview${query}`)
      .set('Cookie', adminCookie);

  it('returns the priced plan without writing anything', async () => {
    const before = await SalesOrderLine.count();

    const res = await preview(printer.id, `?qty=2&partyId=${customer.id}&factoryId=${factory.id}&onDate=2026-08-01`);

    expect(res.status).toBe(200);
    const plan = res.body.data;
    expect(plan.bundleRuleId).toBe(rule.id);
    expect(plan.components.map((c) => c.componentProductId).sort()).toEqual([cable.id, toner.id, kit.id].sort());
    expect(plan.components.find((c) => c.componentProductId === cable.id).qty).toBe(4); // 2 x 2
    expect(plan.optional.map((o) => o.componentProductId)).toEqual([manual.id]);
    expect(plan.totals.taxSummary.map((t) => t.gstRatePercent).sort((a, b) => a - b)).toEqual([12, 18]);

    expect(await SalesOrderLine.count()).toBe(before);
  });

  it('answers plainly for a product with no bundle', async () => {
    const res = await preview(cable.id, '?qty=1');
    expect(res.status).toBe(200);
    expect(res.body.data.bundleRuleId).toBeNull();
    expect(res.body.data.components).toEqual([]);
  });

  it('defaults the quantity to 1', async () => {
    const res = await preview(printer.id, `?partyId=${customer.id}&onDate=2026-08-01`);
    expect(res.status).toBe(200);
    expect(res.body.data.parentQty).toBe(1);
  });

  it('rejects a malformed quantity rather than guessing', async () => {
    const res = await preview(printer.id, '?qty=-3');
    expect(res.status).toBe(400);
  });

  it('requires authentication', async () => {
    const res = await request(app).get(`/api/v1/products/${printer.id}/bundle-preview?qty=1`);
    expect(res.status).toBe(401);
  });
});
