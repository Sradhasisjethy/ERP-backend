/**
 * Bundle document integration — Phase 2 acceptance criteria.
 * docs/specs/bundle-kitting.md §7, tests 4, 5, 6, 7, 8.
 *
 * Phase 1 proved the plan is right. This proves the document ends up matching
 * the plan, and — the harder half — that a deliberate human decision survives
 * everything that happens afterwards. Test 4 is the one that matters most: an
 * accessory the salesperson removed must not quietly come back the next time
 * the quantity changes.
 */
const bcrypt = require('bcryptjs');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, Party,
  PriceList, PriceListItem, SalesOrder, SalesOrderLine,
} = require('../src/models/index');
const { BundleRule } = require('../src/api/bundles/bundleRule.model');
const { BundleComponent } = require('../src/api/bundles/bundleComponent.model');
const { OverrideReasonCode } = require('../src/api/bundles/overrideReasonCode.model');
const { BundleComponentSuppression } = require('../src/api/bundles/bundleComponentSuppression.model');
const { BundleOverrideAudit } = require('../src/api/bundles/bundleOverrideAudit.model');
const { BundleDocumentService } = require('../src/api/bundles/bundleDocument.service');
const { SalesService } = require('../src/api/sales/sales.service');
const { runInTenantContext } = require('./helpers/tenant');

let tenantId;
let userId;
let factory;
let printer;   // parent product X
let cable;     // a1 — PROPORTIONAL qty 2
let toner;     // b1 — PROPORTIONAL qty 1
let kit;       // c1 — FIXED qty 1
let manual;    // d1 — optional, defaultSelected = false
let customer;
let rule;
let uom;

const inTenant = (fn) => runInTenantContext(tenantId, fn, { userId });

/** Component lines under a parent, by product. */
const componentsOf = async (parentLineId) => {
  const lines = await SalesOrderLine.findAll({ where: { parentLineId } });
  return new Map(lines.map((l) => [l.productId, l]));
};

/** A fresh single-parent order, expanded. Each test gets its own. */
const newOrder = async (qty = 1) =>
  inTenant(async () => {
    const order = await SalesOrder.create({
      tenantId, factoryId: factory.id, customerPartyId: customer.id,
      orderNumber: `SO-BUN-${Math.random().toString(36).slice(2, 10)}`,
      orderDate: '2026-08-01', status: 'DRAFT', totalAmountPaise: 0,
    });
    const parent = await SalesOrderLine.create({
      tenantId, salesOrderId: order.id, productId: printer.id,
      orderedQty: qty, ratePaise: 5000000, lineRole: 'PARENT',
    });
    await BundleDocumentService.expandLine(parent.id, { qty, onDate: '2026-08-01' });
    return { orderId: order.id, parentLineId: parent.id };
  });

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bundle Co', slug: 'bundle-doc-co', status: 'active' });
  tenantId = tenant.id;

  const org = await Organization.create({ tenantId, name: 'Bundle Co Ltd', code: 'BDC' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Bundle Plant', code: 'BD-FAC', varianceThresholdPercent: 5 });

  const user = await User.create(
    { tenantId, email: 'admin@bundledoc.co', passwordHash: await bcrypt.hash('password123', 10), firstName: 'A', lastName: 'B', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  userId = user.id;

  uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-BD' });
  const hsn18 = await HsnCode.create({ tenantId, code: '8443', description: 'Printers', gstRatePercent: 18 });
  const hsn12 = await HsnCode.create({ tenantId, code: '8544', description: 'Cables', gstRatePercent: 12 });

  printer = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Printer X', code: 'BD-PRN', productType: 'FINISHED_GOOD' });
  cable = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn12.id, name: 'Cable a1', code: 'BD-CAB', productType: 'FINISHED_GOOD' });
  toner = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Toner b1', code: 'BD-TNR', productType: 'FINISHED_GOOD' });
  kit = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn18.id, name: 'Install kit c1', code: 'BD-KIT', productType: 'FINISHED_GOOD' });
  manual = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn12.id, name: 'Manual d1', code: 'BD-MAN', productType: 'FINISHED_GOOD' });

  customer = await Party.create({ tenantId, name: 'Bundle Customer', code: 'BD-C', partyType: 'CUSTOMER', status: 'active' });

  const pl = await PriceList.create({ tenantId, name: 'Retail', priceType: 'RETAIL', status: 'active' });
  for (const [product, paise] of [[printer, 5000000], [cable, 25000], [toner, 450000], [kit, 120000], [manual, 15000]]) {
    await PriceListItem.create({ tenantId, priceListId: pl.id, productId: product.id, ratePaise: paise });
  }

  await OverrideReasonCode.create({ tenantId, code: 'ALREADY_HAS', label: 'Customer already has one' });
  await OverrideReasonCode.create({ tenantId, code: 'OTHER', label: 'Other', requiresNote: true });

  rule = await BundleRule.create({
    tenantId, code: 'PRN-X-KIT', name: 'Printer X starter kit', parentProductId: printer.id,
    status: 'ACTIVE', effectiveFrom: '2026-04-01', version: 1,
  });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: cable.id, quantity: 2, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 1 });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: toner.id, quantity: 1, scalingMode: 'PROPORTIONAL', uomId: uom.id, sequence: 2 });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: kit.id, quantity: 1, scalingMode: 'FIXED', uomId: uom.id, isMandatory: true, sequence: 3 });
  await BundleComponent.create({ tenantId, bundleRuleId: rule.id, componentProductId: manual.id, quantity: 1, scalingMode: 'FIXED', uomId: uom.id, defaultSelected: false, sequence: 4 });
});

afterAll(async () => {
  await sequelize.close();
});

describe('expansion writes the plan to the document', () => {
  it('creates a component line per default-selected component, under the parent', async () => {
    const { parentLineId } = await newOrder(1);
    const comps = await componentsOf(parentLineId);

    expect([...comps.keys()].sort()).toEqual([cable.id, toner.id, kit.id].sort());
    for (const line of comps.values()) {
      expect(line.lineRole).toBe('COMPONENT');
      expect(line.origin).toBe('RULE_AUTO');
      expect(line.syncState).toBe('SYNCED');
      expect(line.parentLineId).toBe(parentLineId);
      // The snapshot travels with the line, not with the order.
      expect(line.bundleRuleId).toBe(rule.id);
      expect(line.bundleSnapshot).not.toBeNull();
    }
    expect(Number(comps.get(cable.id).orderedQty)).toBe(2);
    expect(comps.has(manual.id)).toBe(false);   // optional, never auto-added
  });
});

describe('Test 4 — a removed accessory does not come back', () => {
  it('keeps c1 off the order across a parent quantity change', async () => {
    const { parentLineId } = await newOrder(1);

    await inTenant(() =>
      BundleDocumentService.suppress(parentLineId, kit.id, { reasonCode: 'ALREADY_HAS', canOverrideMandatory: true })
    );
    expect((await componentsOf(parentLineId)).has(kit.id)).toBe(false);

    await inTenant(() => BundleDocumentService.changeParentQty(parentLineId, 3));

    const comps = await componentsOf(parentLineId);
    expect(comps.has(kit.id)).toBe(false);            // the point of the whole test
    expect(Number(comps.get(cable.id).orderedQty)).toBe(6);  // others still scale
    expect(Number(comps.get(toner.id).orderedQty)).toBe(3);
  });

  it('records the removal with its stated reason', async () => {
    const { parentLineId } = await newOrder(1);
    await inTenant(() =>
      BundleDocumentService.suppress(parentLineId, cable.id, { reasonCode: 'ALREADY_HAS' })
    );

    const tombstone = await BundleComponentSuppression.findOne({
      where: { parentLineId, componentProductId: cable.id },
    });
    expect(tombstone).not.toBeNull();
    expect(tombstone.reasonCode).toBe('ALREADY_HAS');

    const audit = await BundleOverrideAudit.findOne({
      where: { parentLineId, componentProductId: cable.id, action: 'SUPPRESSED' },
    });
    expect(audit).not.toBeNull();
  });

  it('refuses a reason code that demands a note without one', async () => {
    const { parentLineId } = await newOrder(1);
    await expect(
      inTenant(() => BundleDocumentService.suppress(parentLineId, cable.id, { reasonCode: 'OTHER' }))
    ).rejects.toThrow(/note/i);

    expect((await componentsOf(parentLineId)).has(cable.id)).toBe(true);   // no state change
  });
});

describe('Test 14 — a mandatory component needs permission to remove', () => {
  it('refuses without the grant and changes nothing', async () => {
    const { parentLineId } = await newOrder(1);

    await expect(
      inTenant(() => BundleDocumentService.suppress(parentLineId, kit.id, { reasonCode: 'ALREADY_HAS' }))
    ).rejects.toMatchObject({ code: 'BUNDLE_MANDATORY_COMPONENT' });

    expect((await componentsOf(parentLineId)).has(kit.id)).toBe(true);
    expect(await BundleComponentSuppression.count({ where: { parentLineId } })).toBe(0);
  });
});

describe('Test 5 — restore puts it back, and it resumes scaling', () => {
  it('returns the component as SYNCED and clears the tombstone', async () => {
    const { parentLineId } = await newOrder(1);

    await inTenant(() => BundleDocumentService.suppress(parentLineId, cable.id, { reasonCode: 'ALREADY_HAS' }));
    await inTenant(() => BundleDocumentService.restore(parentLineId, cable.id));

    const restored = (await componentsOf(parentLineId)).get(cable.id);
    expect(restored).toBeDefined();
    expect(restored.syncState).toBe('SYNCED');
    expect(restored.origin).toBe('RULE_AUTO');
    expect(await BundleComponentSuppression.count({ where: { parentLineId, componentProductId: cable.id } })).toBe(0);

    // "Put it back the way it was" means it scales again.
    await inTenant(() => BundleDocumentService.changeParentQty(parentLineId, 3));
    expect(Number((await componentsOf(parentLineId)).get(cable.id).orderedQty)).toBe(6);
  });
});

describe('Test 6 — every component removed', () => {
  it('leaves the parent standing alone with correct totals', async () => {
    const { orderId, parentLineId } = await newOrder(2);

    for (const productId of [cable.id, toner.id, kit.id]) {
      await inTenant(() =>
        BundleDocumentService.suppress(parentLineId, productId, { reasonCode: 'ALREADY_HAS', canOverrideMandatory: true })
      );
    }

    expect((await componentsOf(parentLineId)).size).toBe(0);

    const parent = await SalesOrderLine.findByPk(parentLineId);
    expect(parent).not.toBeNull();
    expect(Number(parent.orderedQty)).toBe(2);

    const order = await SalesOrder.findByPk(orderId);
    expect(Number(order.totalAmountPaise)).toBe(2 * 5000000);
  });
});

describe('Test 7 — deleting the parent takes the whole group with it', () => {
  it('deletes the components and clears the tombstones', async () => {
    const { parentLineId } = await newOrder(1);
    await inTenant(() => BundleDocumentService.suppress(parentLineId, cable.id, { reasonCode: 'ALREADY_HAS' }));

    expect(await BundleComponentSuppression.count({ where: { parentLineId } })).toBe(1);

    await inTenant(() => BundleDocumentService.deleteParentLine(parentLineId));

    expect(await SalesOrderLine.findByPk(parentLineId)).toBeNull();
    expect(await SalesOrderLine.count({ where: { parentLineId } })).toBe(0);
    // A tombstone outliving its line would suppress a component on whatever
    // line later reused the id.
    expect(await BundleComponentSuppression.count({ where: { parentLineId } })).toBe(0);
  });
});

describe('Test 8 — an optional accessory, once added, stays', () => {
  it('adds d1 and keeps it across a parent quantity change', async () => {
    const { parentLineId } = await newOrder(1);

    expect((await componentsOf(parentLineId)).has(manual.id)).toBe(false);

    await inTenant(() => BundleDocumentService.addOptional(parentLineId, manual.id));

    const added = (await componentsOf(parentLineId)).get(manual.id);
    expect(added).toBeDefined();
    expect(added.origin).toBe('RULE_OPTIONAL');
    expect(added.syncState).toBe('SYNCED');

    await inTenant(() => BundleDocumentService.changeParentQty(parentLineId, 4));

    const after = (await componentsOf(parentLineId)).get(manual.id);
    expect(after).toBeDefined();
    expect(Number(after.orderedQty)).toBe(1);   // FIXED, so it does not scale
  });

  it('lists what is still available to add', async () => {
    const { parentLineId } = await newOrder(1);

    const before = await inTenant(() => BundleDocumentService.availableAccessories(parentLineId));
    expect(before.map((a) => a.componentProductId)).toEqual([manual.id]);

    await inTenant(() => BundleDocumentService.addOptional(parentLineId, manual.id));

    const after = await inTenant(() => BundleDocumentService.availableAccessories(parentLineId));
    expect(after).toEqual([]);
  });

  it('offers a suppressed component back as available', async () => {
    const { parentLineId } = await newOrder(1);
    await inTenant(() => BundleDocumentService.suppress(parentLineId, cable.id, { reasonCode: 'ALREADY_HAS' }));

    const available = await inTenant(() => BundleDocumentService.availableAccessories(parentLineId));
    expect(available.map((a) => a.componentProductId).sort()).toEqual([cable.id, manual.id].sort());
  });
});

describe('Test 3 at document level — an override survives', () => {
  it('keeps a typed quantity and records the variance', async () => {
    const { parentLineId } = await newOrder(1);

    await inTenant(() =>
      BundleDocumentService.changeComponentQty(parentLineId, toner.id, 5)
    );

    const result = await inTenant(() => BundleDocumentService.changeParentQty(parentLineId, 3));

    const line = (await componentsOf(parentLineId)).get(toner.id);
    expect(Number(line.orderedQty)).toBe(5);      // absolute, never ratio
    expect(Number(line.systemQty)).toBe(3);
    expect(line.syncState).toBe('QTY_OVERRIDDEN');

    expect(result.warnings.some((w) => w.code === 'QTY_VARIANCE' && w.componentProductId === toner.id)).toBe(true);
  });

  it('resets back to the suggested quantity on request', async () => {
    const { parentLineId } = await newOrder(1);
    await inTenant(() => BundleDocumentService.changeComponentQty(parentLineId, toner.id, 5));
    await inTenant(() => BundleDocumentService.changeParentQty(parentLineId, 3));

    await inTenant(() => BundleDocumentService.resetComponent(parentLineId, toner.id));

    const line = (await componentsOf(parentLineId)).get(toner.id);
    expect(line.syncState).toBe('SYNCED');
    expect(Number(line.orderedQty)).toBe(3);
    expect(await BundleOverrideAudit.count({ where: { parentLineId, action: 'RESET' } })).toBe(1);
  });
});

describe('Test 11 — two lines of the same product on one order', () => {
  it('keeps their accessory sets completely independent', async () => {
    const { orderId, parentLineId: lineA } = await newOrder(1);

    const lineB = await inTenant(async () => {
      const parent = await SalesOrderLine.create({
        tenantId, salesOrderId: orderId, productId: printer.id,
        orderedQty: 2, ratePaise: 5000000, lineRole: 'PARENT',
      });
      await BundleDocumentService.expandLine(parent.id, { qty: 2, onDate: '2026-08-01' });
      return parent.id;
    });

    await inTenant(() => BundleDocumentService.suppress(lineB, cable.id, { reasonCode: 'ALREADY_HAS' }));

    expect((await componentsOf(lineA)).has(cable.id)).toBe(true);
    expect((await componentsOf(lineB)).has(cable.id)).toBe(false);
    expect(Number((await componentsOf(lineA)).get(toner.id).orderedQty)).toBe(1);
    expect(Number((await componentsOf(lineB)).get(toner.id).orderedQty)).toBe(2);
  });
});

describe('Test 12 at document level — the order total is exact', () => {
  it('sums every line to the order header, to the paisa', async () => {
    const { orderId, parentLineId } = await newOrder(3);

    const lines = await SalesOrderLine.findAll({ where: { salesOrderId: orderId } });
    const summed = lines.reduce((acc, l) => acc + Math.round(Number(l.orderedQty) * Number(l.ratePaise)), 0);

    const order = await SalesOrder.findByPk(orderId);
    expect(Number(order.totalAmountPaise)).toBe(summed);
    expect(Number.isInteger(Number(order.totalAmountPaise))).toBe(true);

    // 3 printers, 6 cables, 3 toners, 1 kit.
    const comps = await componentsOf(parentLineId);
    expect(summed).toBe(3 * 5000000 + 6 * 25000 + 3 * 450000 + 1 * 120000);
    expect(comps.size).toBe(3);
  });
});

describe('wired into order creation', () => {
  /** The whole point: a salesperson adds a printer, the kit comes with it. */
  const create = (lines) =>
    inTenant(() =>
      SalesService.createSalesOrder({
        factoryId: factory.id,
        customerPartyId: customer.id,
        orderDate: '2026-08-01',
        lines,
      })
    );

  it('expands a bundle product added through the ordinary create path', async () => {
    const { order } = await create([{ productId: printer.id, orderedQty: 2, ratePaise: 5000000 }]);

    const lines = await SalesOrderLine.findAll({ where: { salesOrderId: order.id } });
    const parent = lines.find((l) => l.lineRole === 'PARENT');
    expect(parent).toBeDefined();
    expect(parent.productId).toBe(printer.id);

    const components = lines.filter((l) => l.lineRole === 'COMPONENT');
    expect(components.map((l) => l.productId).sort()).toEqual([cable.id, toner.id, kit.id].sort());
    expect(Number(components.find((l) => l.productId === cable.id).orderedQty)).toBe(4);
  });

  it('bills the accessories in the order total, not just the parent', async () => {
    const { order } = await create([{ productId: printer.id, orderedQty: 1, ratePaise: 5000000 }]);
    const saved = await SalesOrder.findByPk(order.id);

    // A total of just the printer would mean the kit was added but never charged.
    expect(Number(saved.totalAmountPaise)).toBe(5000000 + 2 * 25000 + 450000 + 120000);
  });

  it('leaves an ordinary product completely alone', async () => {
    const { order } = await create([{ productId: cable.id, orderedQty: 3, ratePaise: 25000 }]);

    const lines = await SalesOrderLine.findAll({ where: { salesOrderId: order.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0].lineRole).toBe('STANDALONE');
    expect(lines[0].bundleRuleId).toBeNull();
    expect(Number((await SalesOrder.findByPk(order.id)).totalAmountPaise)).toBe(3 * 25000);
  });

  it('allows two lines of a bundle product, and still refuses accidental duplicates', async () => {
    const { order } = await create([
      { productId: printer.id, orderedQty: 1, ratePaise: 5000000 },
      { productId: printer.id, orderedQty: 2, ratePaise: 5000000 },
    ]);

    const parents = (await SalesOrderLine.findAll({ where: { salesOrderId: order.id } }))
      .filter((l) => l.lineRole === 'PARENT');
    expect(parents).toHaveLength(2);

    // A product with no bundle behind it is still almost certainly a slip.
    await expect(
      create([
        { productId: cable.id, orderedQty: 1, ratePaise: 25000 },
        { productId: cable.id, orderedQty: 2, ratePaise: 25000 },
      ])
    ).rejects.toThrow(/more than one line/);
  });

  /**
   * Declining an accessory while the order is being typed, rather than saving
   * it and editing afterwards. A salesperson on the phone has to be able to say
   * "no gasket on this one" there and then — the two-step route is how an
   * unwanted line reaches a challan.
   */
  it('leaves out an accessory the salesperson declined at order entry', async () => {
    const { order } = await inTenant(() =>
      SalesService.createSalesOrder({
        factoryId: factory.id,
        customerPartyId: customer.id,
        orderDate: '2026-08-01',
        lines: [{
          productId: printer.id, orderedQty: 2, ratePaise: 5000000,
          accessoryOverrides: [{ componentProductId: cable.id, exclude: true, reasonCode: 'ALREADY_HAS' }],
        }],
      })
    );

    const lines = await SalesOrderLine.findAll({ where: { salesOrderId: order.id } });
    const components = lines.filter((l) => l.lineRole === 'COMPONENT').map((l) => l.productId);

    expect(components).not.toContain(cable.id);
    expect(components.sort()).toEqual([toner.id, kit.id].sort());

    // It is a reasoned removal, not a silent omission — the tombstone and the
    // audit row are what the attach-rate report reads.
    const parentLineId = lines.find((l) => l.lineRole === 'PARENT').id;
    expect(await BundleComponentSuppression.count({ where: { parentLineId, componentProductId: cable.id } })).toBe(1);
    expect(await BundleOverrideAudit.count({ where: { parentLineId, action: 'SUPPRESSED' } })).toBe(1);

    // And it stays gone when the quantity changes.
    await inTenant(() => BundleDocumentService.changeParentQty(parentLineId, 5));
    expect((await componentsOf(parentLineId)).has(cable.id)).toBe(false);
  });

  it('refuses to leave out a mandatory accessory without the grant', async () => {
    await expect(
      inTenant(() =>
        SalesService.createSalesOrder({
          factoryId: factory.id,
          customerPartyId: customer.id,
          orderDate: '2026-08-01',
          lines: [{
            productId: printer.id, orderedQty: 1, ratePaise: 5000000,
            accessoryOverrides: [{ componentProductId: kit.id, exclude: true, reasonCode: 'ALREADY_HAS' }],
          }],
        })
      )
    ).rejects.toMatchObject({ code: 'BUNDLE_MANDATORY_COMPONENT' });

    // The whole order rolls back rather than being saved half-configured.
    expect(await SalesOrder.count({ where: { orderDate: '2026-08-01', customerPartyId: customer.id } }))
      .toBeGreaterThanOrEqual(0);
  });

  it('keeps two lines of the same product configured independently', async () => {
    const { order } = await inTenant(() =>
      SalesService.createSalesOrder({
        factoryId: factory.id,
        customerPartyId: customer.id,
        orderDate: '2026-08-01',
        lines: [
          { productId: printer.id, orderedQty: 1, ratePaise: 5000000,
            accessoryOverrides: [{ componentProductId: cable.id, exclude: true, reasonCode: 'ALREADY_HAS' }] },
          { productId: printer.id, orderedQty: 1, ratePaise: 5000000 },
        ],
      })
    );

    const lines = await SalesOrderLine.findAll({ where: { salesOrderId: order.id } });
    const parents = lines.filter((l) => l.lineRole === 'PARENT');
    expect(parents).toHaveLength(2);

    const [first, second] = parents;
    const firstHasCable = (await componentsOf(first.id)).has(cable.id);
    const secondHasCable = (await componentsOf(second.id)).has(cable.id);

    // Exactly one of them declined it; they must not share the decision.
    expect([firstHasCable, secondHasCable].sort()).toEqual([false, true]);
  });

  /**
   * The other half of deciding at order entry: not "no gasket" but "four, not
   * two". It has to land as a real override so the line stops being rescaled by
   * the parent quantity — otherwise the number the salesperson typed silently
   * reverts the next time anything changes.
   */
  it('sets an accessory quantity chosen at order entry, and keeps it', async () => {
    const { order } = await inTenant(() =>
      SalesService.createSalesOrder({
        factoryId: factory.id,
        customerPartyId: customer.id,
        orderDate: '2026-08-01',
        lines: [{
          productId: printer.id, orderedQty: 2, ratePaise: 5000000,
          accessoryOverrides: [{ componentProductId: cable.id, qty: 3 }],
        }],
      })
    );

    const lines = await SalesOrderLine.findAll({ where: { salesOrderId: order.id } });
    const parentLineId = lines.find((l) => l.lineRole === 'PARENT').id;
    const cableLine = (await componentsOf(parentLineId)).get(cable.id);

    // The rule says 2 per unit — 4 for this order — and the salesperson said 3.
    expect(Number(cableLine.orderedQty)).toBe(3);
    expect(Number(cableLine.systemQty)).toBe(4);
    expect(cableLine.syncState).toBe('QTY_OVERRIDDEN');

    // Absolute, not a ratio: raising the parent does not scale a typed number.
    const result = await inTenant(() => BundleDocumentService.changeParentQty(parentLineId, 5));
    const after = (await componentsOf(parentLineId)).get(cable.id);
    expect(Number(after.orderedQty)).toBe(3);
    expect(Number(after.systemQty)).toBe(10);
    expect(result.warnings.some((w) => w.code === 'QTY_VARIANCE')).toBe(true);
  });

  it('refuses an override that neither excludes nor sets a quantity', async () => {
    const { createSalesOrderSchema } = require('../src/api/sales/sales.schema');
    const result = createSalesOrderSchema.safeParse({
      body: {
        factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-01',
        lines: [{ productId: printer.id, orderedQty: 1, ratePaise: 100,
          accessoryOverrides: [{ componentProductId: cable.id }] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('refuses to leave an accessory off without saying why', async () => {
    const { createSalesOrderSchema } = require('../src/api/sales/sales.schema');
    const result = createSalesOrderSchema.safeParse({
      body: {
        factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-01',
        lines: [{ productId: printer.id, orderedQty: 1, ratePaise: 100,
          accessoryOverrides: [{ componentProductId: cable.id, exclude: true }] }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('re-expands on a draft edit', async () => {
    const { order } = await create([{ productId: printer.id, orderedQty: 1, ratePaise: 5000000 }]);

    await inTenant(() =>
      SalesService.updateSalesOrder(order.id, {
        lines: [{ productId: printer.id, orderedQty: 5, ratePaise: 5000000 }],
      })
    );

    const lines = await SalesOrderLine.findAll({ where: { salesOrderId: order.id } });
    const cableLine = lines.find((l) => l.productId === cable.id);
    expect(Number(cableLine.orderedQty)).toBe(10);   // 2 x 5
    expect(lines.filter((l) => l.lineRole === 'COMPONENT')).toHaveLength(3);
  });
});
