const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, ProductCategory, Product,
  Party, AdGroup, AdGroupMember, AuditLog, MixDesign, PriceList, PriceListItem,
} = require('../src/models/index');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

/** One self-contained tenant with an admin, so isolation can be tested for real. */
const buildTenant = async (slug, adminEmail) => {
  const tenant = await Tenant.create({ name: slug, slug, status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: `${slug} Ltd`, code: slug.toUpperCase().slice(0, 6) });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create(
    { tenantId, email: adminEmail, passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  const factory = await Factory.create({ tenantId, organizationId: org.id, name: `${slug} Plant`, code: `${slug}-F1` });
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: `NOS-${slug}` });
  return { tenantId, org, factory, uom, cookie: await loginAs(adminEmail) };
};

let A; // tenant A
let B; // tenant B
let readOnlyCookie;

beforeAll(async () => {
  await resetDatabase();
  A = await buildTenant('audit-a', 'admin@audit-a.test');
  B = await buildTenant('audit-b', 'admin@audit-b.test');

  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const viewer = await User.create(
    { tenantId: A.tenantId, email: 'viewer@audit-a.test', passwordHash, firstName: 'View', lastName: 'Only', role: 'EMPLOYEE' },
    { validate: false }
  );
  const group = await AdGroup.create({
    tenantId: A.tenantId,
    name: 'Masters Viewer',
    permissions: ['PARTY_READ', 'PRODUCT_READ'],
  });
  await AdGroupMember.create({ tenantId: A.tenantId, adGroupId: group.id, employeeId: viewer.id });
  readOnlyCookie = await loginAs('viewer@audit-a.test');
});

afterAll(async () => {
  await sequelize.close();
});

// ---------------------------------------------------------------------------
// 1. Multi-tenant isolation (Organization scope)
// ---------------------------------------------------------------------------
describe('Multi-tenant isolation across every master', () => {
  it('never returns another tenant\'s parties, products, categories, UoMs or BOMs', async () => {
    const bParty = await Party.create({ tenantId: B.tenantId, partyType: 'CUSTOMER', name: 'B Customer', code: 'B-CUST' });
    const bCategory = await ProductCategory.create({ tenantId: B.tenantId, name: 'B Category', code: 'B-CAT' });
    const bProduct = await Product.create({ tenantId: B.tenantId, uomId: B.uom.id, name: 'B Product', code: 'B-PROD' });
    const bBom = await MixDesign.create({ tenantId: B.tenantId, productId: bProduct.id, name: 'B Mix', version: 1 });

    const cases = [
      ['/api/v1/parties', bParty.id],
      ['/api/v1/products', bProduct.id],
      ['/api/v1/product-categories', bCategory.id],
      ['/api/v1/uoms', B.uom.id],
      ['/api/v1/mix-designs', bBom.id],
    ];

    for (const [path, id] of cases) {
      const direct = await request(app).get(`${path}/${id}`).set('Cookie', A.cookie);
      expect([403, 404]).toContain(direct.status);

      const list = await request(app).get(`${path}?limit=100`).set('Cookie', A.cookie);
      expect(list.status).toBe(200);
      expect(list.body.data.rows.some((r) => r.id === id)).toBe(false);
    }
  });

  it('refuses a cross-tenant update and delete', async () => {
    const bProduct = await Product.create({ tenantId: B.tenantId, uomId: B.uom.id, name: 'B Locked', code: 'B-LOCK' });
    const update = await request(app).put(`/api/v1/products/${bProduct.id}`).set('Cookie', A.cookie).send({ name: 'Hijacked' });
    expect([403, 404]).toContain(update.status);
    const remove = await request(app).delete(`/api/v1/products/${bProduct.id}`).set('Cookie', A.cookie);
    expect([403, 404]).toContain(remove.status);
    expect((await Product.findOne({ where: { id: bProduct.id }, paranoid: false })) === null).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 2. RBAC enforced at the API, not just hidden in the UI
// ---------------------------------------------------------------------------
describe('RBAC on masters is enforced server-side', () => {
  it('allows READ but refuses CREATE / MODIFY / DELETE for a read-only role', async () => {
    const list = await request(app).get('/api/v1/parties').set('Cookie', readOnlyCookie);
    expect(list.status).toBe(200);

    const create = await request(app)
      .post('/api/v1/parties')
      .set('Cookie', readOnlyCookie)
      .send({ partyType: 'CUSTOMER', name: 'Sneaky Customer' });
    expect(create.status).toBe(403);

    const seeded = await Party.create({ tenantId: A.tenantId, partyType: 'CUSTOMER', name: 'RBAC Target' });
    expect((await request(app).put(`/api/v1/parties/${seeded.id}`).set('Cookie', readOnlyCookie).send({ name: 'X' })).status).toBe(403);
    expect((await request(app).delete(`/api/v1/parties/${seeded.id}`).set('Cookie', readOnlyCookie)).status).toBe(403);

    const productCreate = await request(app)
      .post('/api/v1/products')
      .set('Cookie', readOnlyCookie)
      .send({ uomId: A.uom.id, name: 'Sneaky Product', code: 'SNEAK-1' });
    expect(productCreate.status).toBe(403);
  });

  it('rejects an unauthenticated request outright', async () => {
    expect((await request(app).get('/api/v1/products')).status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// 3. Duplicate prevention
// ---------------------------------------------------------------------------
describe('Duplicate prevention on master identity', () => {
  it('refuses a second party with the same code', async () => {
    const body = { partyType: 'CUSTOMER', name: 'Acme Traders', code: 'DUP-CUST-1' };
    expect((await request(app).post('/api/v1/parties').set('Cookie', A.cookie).send(body)).status).toBe(201);

    const second = await request(app)
      .post('/api/v1/parties')
      .set('Cookie', A.cookie)
      .send({ ...body, name: 'Acme Traders Duplicate' });
    expect(second.status).toBe(409);
  });

  it('refuses a second party of the same type with the same GSTIN', async () => {
    const gstin = '21AAAAA0000A1Z5';
    expect(
      (await request(app).post('/api/v1/parties').set('Cookie', A.cookie).send({ partyType: 'VENDOR', name: 'GST Vendor', gstin })).status
    ).toBe(201);

    const second = await request(app)
      .post('/api/v1/parties')
      .set('Cookie', A.cookie)
      .send({ partyType: 'VENDOR', name: 'GST Vendor Again', gstin });
    expect(second.status).toBe(409);
  });

  it('still allows the same GSTIN for a different party role', async () => {
    const gstin = '21BBBBB0000B1Z5';
    expect(
      (await request(app).post('/api/v1/parties').set('Cookie', A.cookie).send({ partyType: 'CUSTOMER', name: 'Dual Role', gstin })).status
    ).toBe(201);
    expect(
      (await request(app).post('/api/v1/parties').set('Cookie', A.cookie).send({ partyType: 'VENDOR', name: 'Dual Role', gstin })).status
    ).toBe(201);
  });

  it('refuses a duplicate product code and a duplicate category code', async () => {
    expect(
      (await request(app).post('/api/v1/products').set('Cookie', A.cookie).send({ uomId: A.uom.id, name: 'Widget', code: 'DUP-PROD-1' })).status
    ).toBe(201);
    expect(
      (await request(app).post('/api/v1/products').set('Cookie', A.cookie).send({ uomId: A.uom.id, name: 'Widget 2', code: 'DUP-PROD-1' })).status
    ).toBe(409);

    expect((await request(app).post('/api/v1/product-categories').set('Cookie', A.cookie).send({ name: 'Blocks', code: 'DUP-CAT-1' })).status).toBe(201);
    expect((await request(app).post('/api/v1/product-categories').set('Cookie', A.cookie).send({ name: 'Blocks 2', code: 'DUP-CAT-1' })).status).toBe(409);
  });

  it('lets two different tenants each hold the same code', async () => {
    expect(
      (await request(app).post('/api/v1/products').set('Cookie', B.cookie).send({ uomId: B.uom.id, name: 'Same Code', code: 'DUP-PROD-1' })).status
    ).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// 4. Historical-integrity protection on delete
// ---------------------------------------------------------------------------
describe('Deleting a master never destroys history', () => {
  it('refuses to delete a product that has a BOM, and leaves the BOM intact', async () => {
    const product = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'BOM Parent', code: 'BOM-PARENT' });
    const raw = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'BOM Child', code: 'BOM-CHILD', productType: 'RAW_MATERIAL' });
    const bom = await request(app)
      .post('/api/v1/mix-designs')
      .set('Cookie', A.cookie)
      .send({ productId: product.id, name: 'Recipe', lines: [{ rawMaterialProductId: raw.id, quantityPerUnit: 2, uomId: A.uom.id }] });
    expect(bom.status).toBe(201);

    const res = await request(app).delete(`/api/v1/products/${product.id}`).set('Cookie', A.cookie);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/bill of materials|mix design/i);

    expect(await MixDesign.count({ where: { productId: product.id } })).toBe(1);
    expect(await Product.count({ where: { id: product.id } })).toBe(1);
  });

  it('refuses to delete a product referenced by a price list, and leaves the price row intact', async () => {
    const product = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Priced', code: 'PRICED-1' });
    const list = await PriceList.create({ tenantId: A.tenantId, name: 'Retail', priceType: 'RETAIL' });
    await PriceListItem.create({ tenantId: A.tenantId, priceListId: list.id, productId: product.id, ratePaise: 5000 });

    const res = await request(app).delete(`/api/v1/products/${product.id}`).set('Cookie', A.cookie);
    expect(res.status).toBe(409);
    expect(await PriceListItem.count({ where: { productId: product.id } })).toBe(1);
  });

  it('refuses to delete a customer that has a sales order, and leaves the order intact', async () => {
    const customer = await Party.create({ tenantId: A.tenantId, partyType: 'CUSTOMER', name: 'Ordering Customer' });
    const product = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Sold Item', code: 'SOLD-1' });

    const order = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', A.cookie)
      .send({
        factoryId: A.factory.id,
        customerPartyId: customer.id,
        orderDate: '2026-08-10',
        lines: [{ productId: product.id, orderedQty: 5, ratePaise: 1000 }],
      });
    expect(order.status).toBe(201);

    const res = await request(app).delete(`/api/v1/parties/${customer.id}`).set('Cookie', A.cookie);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/sales order|in use|deactivate/i);

    const check = await request(app).get(`/api/v1/sales/orders/${order.body.data.id}`).set('Cookie', A.cookie);
    expect(check.status).toBe(200);
    expect(check.body.data.customer.name).toBe('Ordering Customer');
  });

  it('refuses to delete a product that has stock movement', async () => {
    const vendor = await Party.create({ tenantId: A.tenantId, partyType: 'VENDOR', name: 'Stock Vendor' });
    const product = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Received Item', code: 'RECV-1' });
    const grn = await request(app)
      .post('/api/v1/purchasing/receipts')
      .set('Cookie', A.cookie)
      .send({
        factoryId: A.factory.id,
        vendorPartyId: vendor.id,
        receiptDate: '2026-08-10',
        lines: [{ productId: product.id, receivedQty: 20, ratePaise: 500 }],
      });
    expect(grn.status).toBe(201);

    const res = await request(app).delete(`/api/v1/products/${product.id}`).set('Cookie', A.cookie);
    expect(res.status).toBe(409);
    expect(await Product.count({ where: { id: product.id } })).toBe(1);
  });

  it('still allows deleting a genuinely unused master', async () => {
    const unused = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Never Used', code: 'UNUSED-1' });
    expect((await request(app).delete(`/api/v1/products/${unused.id}`).set('Cookie', A.cookie)).status).toBe(200);
    expect(await Product.count({ where: { id: unused.id } })).toBe(0);

    const party = await Party.create({ tenantId: A.tenantId, partyType: 'CONTRACTOR', name: 'Never Engaged' });
    expect((await request(app).delete(`/api/v1/parties/${party.id}`).set('Cookie', A.cookie)).status).toBe(200);
  });

  it('refuses to delete a UoM or category still in use', async () => {
    const uom = await Uom.create({ tenantId: A.tenantId, name: 'Kilogram', code: `KG-INUSE` });
    const category = await ProductCategory.create({ tenantId: A.tenantId, name: 'In Use Cat', code: 'CAT-INUSE' });
    await Product.create({ tenantId: A.tenantId, uomId: uom.id, categoryId: category.id, name: 'Uses Both', code: 'USES-BOTH' });

    expect((await request(app).delete(`/api/v1/uoms/${uom.id}`).set('Cookie', A.cookie)).status).toBe(409);
    expect((await request(app).delete(`/api/v1/product-categories/${category.id}`).set('Cookie', A.cookie)).status).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// 5. Referential correctness of masters used by transactions
// ---------------------------------------------------------------------------
describe('Transactions may only reference a valid, active master of the right kind', () => {
  it('refuses a sales order raised against a VENDOR party', async () => {
    const vendor = await Party.create({ tenantId: A.tenantId, partyType: 'VENDOR', name: 'Not A Customer' });
    const product = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Any', code: 'ANY-1' });

    const res = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', A.cookie)
      .send({
        factoryId: A.factory.id,
        customerPartyId: vendor.id,
        orderDate: '2026-08-10',
        lines: [{ productId: product.id, orderedQty: 1, ratePaise: 100 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/customer/i);
  });

  it('refuses a sales order for an inactive customer', async () => {
    const customer = await Party.create({ tenantId: A.tenantId, partyType: 'CUSTOMER', name: 'Retired Customer', status: 'inactive' });
    const product = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Any 2', code: 'ANY-2' });

    const res = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', A.cookie)
      .send({
        factoryId: A.factory.id,
        customerPartyId: customer.id,
        orderDate: '2026-08-10',
        lines: [{ productId: product.id, orderedQty: 1, ratePaise: 100 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/inactive/i);
  });

  it('refuses a sales order line for an inactive product', async () => {
    const customer = await Party.create({ tenantId: A.tenantId, partyType: 'CUSTOMER', name: 'Live Customer' });
    const product = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Discontinued', code: 'DISC-1', status: 'inactive' });

    const res = await request(app)
      .post('/api/v1/sales/orders')
      .set('Cookie', A.cookie)
      .send({
        factoryId: A.factory.id,
        customerPartyId: customer.id,
        orderDate: '2026-08-10',
        lines: [{ productId: product.id, orderedQty: 1, ratePaise: 100 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/inactive/i);
  });

  it('refuses a purchase order raised against a CUSTOMER party', async () => {
    const customer = await Party.create({ tenantId: A.tenantId, partyType: 'CUSTOMER', name: 'Not A Vendor' });
    const product = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Any 3', code: 'ANY-3' });

    const res = await request(app)
      .post('/api/v1/purchasing/orders')
      .set('Cookie', A.cookie)
      .send({
        factoryId: A.factory.id,
        vendorPartyId: customer.id,
        orderDate: '2026-08-10',
        lines: [{ productId: product.id, orderedQty: 1, ratePaise: 100 }],
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/vendor/i);
  });
});

// ---------------------------------------------------------------------------
// 6. BOM integrity
// ---------------------------------------------------------------------------
describe('BOM structural integrity', () => {
  it('refuses a BOM whose own product appears as a component', async () => {
    const product = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Self Eater', code: 'SELF-1' });
    const res = await request(app)
      .post('/api/v1/mix-designs')
      .set('Cookie', A.cookie)
      .send({ productId: product.id, name: 'Self Recipe', lines: [{ rawMaterialProductId: product.id, quantityPerUnit: 1, uomId: A.uom.id }] });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/its own|itself|circular/i);
  });

  it('refuses an indirect circular BOM (A needs B, B needs A)', async () => {
    const a = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Cycle A', code: 'CYC-A' });
    const b = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Cycle B', code: 'CYC-B' });

    const first = await request(app)
      .post('/api/v1/mix-designs')
      .set('Cookie', A.cookie)
      .send({ productId: a.id, name: 'A needs B', activate: true, lines: [{ rawMaterialProductId: b.id, quantityPerUnit: 1, uomId: A.uom.id }] });
    expect(first.status).toBe(201);

    const second = await request(app)
      .post('/api/v1/mix-designs')
      .set('Cookie', A.cookie)
      .send({ productId: b.id, name: 'B needs A', activate: true, lines: [{ rawMaterialProductId: a.id, quantityPerUnit: 1, uomId: A.uom.id }] });
    expect(second.status).toBe(400);
    expect(second.body.message).toMatch(/circular/i);
  });

  it('refuses duplicate component lines within one BOM', async () => {
    const product = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Dup Lines', code: 'DUPL-1' });
    const raw = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Dup Raw', code: 'DUPR-1', productType: 'RAW_MATERIAL' });
    const res = await request(app)
      .post('/api/v1/mix-designs')
      .set('Cookie', A.cookie)
      .send({
        productId: product.id,
        name: 'Twice',
        lines: [
          { rawMaterialProductId: raw.id, quantityPerUnit: 1, uomId: A.uom.id },
          { rawMaterialProductId: raw.id, quantityPerUnit: 2, uomId: A.uom.id },
        ],
      });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/more than once|duplicate/i);
  });

  it('refuses a BOM referencing a product from another tenant', async () => {
    const mine = await Product.create({ tenantId: A.tenantId, uomId: A.uom.id, name: 'Mine', code: 'MINE-1' });
    const theirs = await Product.create({ tenantId: B.tenantId, uomId: B.uom.id, name: 'Theirs', code: 'THEIRS-1' });
    const res = await request(app)
      .post('/api/v1/mix-designs')
      .set('Cookie', A.cookie)
      .send({ productId: mine.id, name: 'Cross', lines: [{ rawMaterialProductId: theirs.id, quantityPerUnit: 1, uomId: A.uom.id }] });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 7. Sorting actually reaches the database
// ---------------------------------------------------------------------------
describe('Server-side sorting on master lists', () => {
  it('orders products by name in both directions across the whole result set', async () => {
    for (const code of ['SORT-C', 'SORT-A', 'SORT-B']) {
      await Product.create({ tenantId: B.tenantId, uomId: B.uom.id, name: `Sortable ${code}`, code });
    }

    const asc = await request(app).get('/api/v1/products?sortBy=code&sortDir=asc&limit=100').set('Cookie', B.cookie);
    const desc = await request(app).get('/api/v1/products?sortBy=code&sortDir=desc&limit=100').set('Cookie', B.cookie);
    expect(asc.status).toBe(200);

    const ascCodes = asc.body.data.rows.map((r) => r.code).filter((c) => c.startsWith('SORT-'));
    const descCodes = desc.body.data.rows.map((r) => r.code).filter((c) => c.startsWith('SORT-'));
    expect(ascCodes).toEqual(['SORT-A', 'SORT-B', 'SORT-C']);
    expect(descCodes).toEqual(['SORT-C', 'SORT-B', 'SORT-A']);
  });

  it('sorts parties and ignores an unknown sort column instead of failing', async () => {
    const asc = await request(app).get('/api/v1/parties?sortBy=name&sortDir=asc&limit=100').set('Cookie', B.cookie);
    expect(asc.status).toBe(200);
    const bogus = await request(app).get('/api/v1/parties?sortBy=passwordHash--&sortDir=asc').set('Cookie', B.cookie);
    expect(bogus.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// 8. Audit trail (BR-30)
// ---------------------------------------------------------------------------
describe('Audit trail covers every master', () => {
  it('records CREATE and UPDATE for UoM, category and HSN code', async () => {
    const uom = await request(app).post('/api/v1/uoms').set('Cookie', A.cookie).send({ name: 'Audited Unit', code: 'AUD-U1' });
    expect(uom.status).toBe(201);
    const category = await request(app).post('/api/v1/product-categories').set('Cookie', A.cookie).send({ name: 'Audited Cat', code: 'AUD-C1' });
    expect(category.status).toBe(201);
    const hsn = await request(app).post('/api/v1/hsn-codes').set('Cookie', A.cookie).send({ code: 'AUD-H1', gstRatePercent: 18 });
    expect(hsn.status).toBe(201);

    await request(app).put(`/api/v1/uoms/${uom.body.data.id}`).set('Cookie', A.cookie).send({ name: 'Audited Unit v2' });

    for (const [entityType, entityId] of [['Uom', uom.body.data.id], ['ProductCategory', category.body.data.id], ['HsnCode', hsn.body.data.id]]) {
      const created = await AuditLog.findOne({ where: { entityType, entityId, action: 'CREATE' } });
      expect(created).not.toBeNull();
      expect(created.userId).not.toBeNull();
    }

    const updated = await AuditLog.findOne({ where: { entityType: 'Uom', entityId: uom.body.data.id, action: 'UPDATE' } });
    expect(updated).not.toBeNull();
    expect(updated.afterSnapshot.name).toBe('Audited Unit v2');
  });

  it('attributes an organization change to the acting user', async () => {
    const org = await request(app).post('/api/v1/organizations').set('Cookie', A.cookie)
      .send({ name: 'Audited Org', code: 'AUD-ORG', gstin: '21BBBBB0000B1Z5' });
    expect(org.status).toBe(201);
    const entry = await AuditLog.findOne({ where: { entityType: 'Organization', entityId: org.body.data.id, action: 'CREATE' } });
    expect(entry).not.toBeNull();
    expect(entry.userId).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 9. Validation
// ---------------------------------------------------------------------------
describe('Master field validation', () => {
  it('rejects a malformed GSTIN', async () => {
    const res = await request(app)
      .post('/api/v1/parties')
      .set('Cookie', A.cookie)
      .send({ partyType: 'CUSTOMER', name: 'Bad GST', gstin: 'NOT-A-GSTIN' });
    expect(res.status).toBe(400);
  });

  it('accepts a well-formed GSTIN', async () => {
    const res = await request(app)
      .post('/api/v1/parties')
      .set('Cookie', A.cookie)
      .send({ partyType: 'CUSTOMER', name: 'Good GST', gstin: '21ABCDE1234F1Z5' });
    expect(res.status).toBe(201);
  });

  it('rejects a product whose maxStock is below its minStock', async () => {
    const res = await request(app)
      .post('/api/v1/products')
      .set('Cookie', A.cookie)
      .send({ uomId: A.uom.id, name: 'Bad Range', code: 'BADR-1', minStock: 100, maxStock: 10 });
    expect(res.status).toBe(400);
  });

  it('rejects a category that is its own parent', async () => {
    const cat = await ProductCategory.create({ tenantId: A.tenantId, name: 'Loop Cat', code: 'LOOP-1' });
    const res = await request(app).put(`/api/v1/product-categories/${cat.id}`).set('Cookie', A.cookie).send({ parentId: cat.id });
    expect(res.status).toBe(400);
  });
});

// ---------------------------------------------------------------------------
// 10. Party addresses belong to their party
// ---------------------------------------------------------------------------
describe('Party address scoping', () => {
  it('refuses to edit an address through a different party\'s URL', async () => {
    const owner = await Party.create({ tenantId: A.tenantId, partyType: 'CUSTOMER', name: 'Address Owner' });
    const other = await Party.create({ tenantId: A.tenantId, partyType: 'CUSTOMER', name: 'Address Bystander' });

    const address = await request(app)
      .post(`/api/v1/parties/${owner.id}/addresses`)
      .set('Cookie', A.cookie)
      .send({ line1: '1 Main Road', state: 'Odisha' });
    expect(address.status).toBe(201);

    const res = await request(app)
      .put(`/api/v1/parties/${other.id}/addresses/${address.body.data.id}`)
      .set('Cookie', A.cookie)
      .send({ line1: 'Hijacked' });
    expect(res.status).toBe(404);
  });
});
