const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, Party, PriceList, PriceListItem,
} = require('../src/models/index');
const { Quotation } = require('../src/api/quotations/quotation.model');

/**
 * Quotations, and converting one into a sales order.
 *
 * Paver: HSN 6810 at 18%, selling price ₹60, wholesale list ₹40.
 *   quoted 10 @ ₹50 less 10% → taxable ₹450, GST ₹81, total ₹531
 *   converted → order line at the net rate, ₹45 each
 */

const PASSWORD = 'password123';
let cookie;
let factory;
let paver;
let bolt;
let customer;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const api = {
  get: (url, query) => request(app).get(url).set('Cookie', cookie).query(query || {}),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookie).send(body),
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Quote Precast', slug: 'quote-precast', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Quote Precast Pvt Ltd', code: 'QPL' });
  await User.create(
    { tenantId, email: 'admin@quotes.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Quote Plant', code: 'QTE', state: 'Odisha' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-QTE' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast concrete', gstRatePercent: 18 });
  paver = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Paver Qte', code: 'FG-PAV-QTE', productType: 'FINISHED_GOOD', curingDays: 0, sellingPricePaise: 6000 });
  bolt = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Bolt Qte', code: 'FG-BOLT-QTE', productType: 'FINISHED_GOOD', curingDays: 0, sellingPricePaise: 1000 });
  customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Konark Builders', state: 'Odisha' });

  const list = await PriceList.create({ tenantId, name: 'Trade 2026', priceType: 'WHOLESALE', status: 'active' });
  await PriceListItem.create({ tenantId, priceListId: list.id, productId: paver.id, ratePaise: 4000 });

  cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@quotes.co', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('Creating a quotation', () => {
  let quote;

  it('prices the lines, taking the discount off before GST', async () => {
    const res = await api.post('/api/v1/quotations', {
      factoryId: factory.id, quotationDate: '2026-06-01', validUntil: '2026-12-31',
      prospect: { name: 'Sahoo Contractors', phone: '9861000111' },
      lines: [{ productId: paver.id, quantity: 10, ratePaise: 5000, discountPercent: 10 }],
      terms: 'Ex-works. 50% advance.',
    });
    expect(res.status).toBe(201);
    quote = res.body.data;
    expect(quote.quotationNumber).toMatch(/^QT\//);
    expect(quote.status).toBe('DRAFT');
    expect(quote.buyerName).toBe('Sahoo Contractors');
    expect(quote.lines[0]).toMatchObject({ taxableAmountPaise: 45000, discountPaise: 5000, cgstPaise: 4050, sgstPaise: 4050 });
    expect(quote.totalPaise).toBe(53100);
    expect(quote.isExpired).toBe(false);
  });

  it('creates no customer for a prospect who may never buy', async () => {
    expect(await Party.count({ where: { name: 'Sahoo Contractors' } })).toBe(0);
  });

  it('takes the wholesale rate when no rate is given, and the selling price when there is no list entry', async () => {
    const res = await api.post('/api/v1/quotations', {
      factoryId: factory.id, quotationDate: '2026-06-02', validUntil: '2026-07-02',
      customerPartyId: customer.id,
      lines: [{ productId: paver.id, quantity: 2 }, { productId: bolt.id, quantity: 5 }],
    });
    expect(res.status).toBe(201);
    const byProduct = Object.fromEntries(res.body.data.lines.map((l) => [l.productId, l]));
    expect(byProduct[paver.id].ratePaise).toBe(4000);
    expect(byProduct[bolt.id].ratePaise).toBe(1000);
  });

  it('refuses a validity date before the quotation date', async () => {
    const res = await api.post('/api/v1/quotations', {
      factoryId: factory.id, quotationDate: '2026-06-02', validUntil: '2026-06-01',
      customerPartyId: customer.id, lines: [{ productId: paver.id, quantity: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it('refuses a quotation with neither a customer nor a name', async () => {
    const res = await api.post('/api/v1/quotations', {
      factoryId: factory.id, quotationDate: '2026-06-02', validUntil: '2026-07-02', lines: [{ productId: paver.id, quantity: 1 }],
    });
    expect(res.status).toBe(400);
  });

  it('re-prices on edit', async () => {
    const res = await api.put(`/api/v1/quotations/${quote.id}`, {
      lines: [{ productId: paver.id, quantity: 20, ratePaise: 5000, discountPercent: 10 }],
    });
    expect(res.status).toBe(200);
    expect(res.body.data.totalPaise).toBe(106200);
    quote = res.body.data;
  });
});

describe('The offer moving along', () => {
  let quote;

  beforeAll(async () => {
    quote = (await api.post('/api/v1/quotations', {
      factoryId: factory.id, quotationDate: '2026-06-03', validUntil: '2026-12-31',
      customerPartyId: customer.id,
      lines: [{ productId: paver.id, quantity: 10, ratePaise: 5000, discountPercent: 10 }],
    })).body.data;
  });

  it('is sent, then accepted', async () => {
    expect((await api.put(`/api/v1/quotations/${quote.id}/status`, { status: 'SENT' })).body.data.status).toBe('SENT');
    expect((await api.put(`/api/v1/quotations/${quote.id}/status`, { status: 'ACCEPTED' })).body.data.status).toBe('ACCEPTED');
  });

  it('needs a reason to be rejected', async () => {
    const other = (await api.post('/api/v1/quotations', {
      factoryId: factory.id, quotationDate: '2026-06-03', validUntil: '2026-12-31',
      customerPartyId: customer.id, lines: [{ productId: paver.id, quantity: 1 }],
    })).body.data;
    expect((await api.put(`/api/v1/quotations/${other.id}/status`, { status: 'REJECTED' })).status).toBe(400);
    const res = await api.put(`/api/v1/quotations/${other.id}/status`, { status: 'REJECTED', reason: 'Lost on price to Konark Concrete' });
    expect(res.status).toBe(200);
    expect(res.body.data.statusReason).toMatch(/Lost on price/);
  });

  it('becomes a sales order at the net rate', async () => {
    const res = await api.post(`/api/v1/quotations/${quote.id}/convert`, { orderDate: '2026-06-05' });
    expect(res.status).toBe(201);
    expect(res.body.data.quotation.status).toBe('CONVERTED');
    const order = res.body.data.order;
    expect(order.poReferenceNumber).toBe(`Quotation ${quote.quotationNumber}`);
    expect(Number(order.totalAmountPaise)).toBe(45000);
    expect(Number(order.lines[0].ratePaise)).toBe(4500);
  });

  it('will not be converted or edited twice', async () => {
    expect((await api.post(`/api/v1/quotations/${quote.id}/convert`, {})).status).toBe(400);
    expect((await api.put(`/api/v1/quotations/${quote.id}`, { lines: [{ productId: paver.id, quantity: 1 }] })).status).toBe(400);
  });

  it('turns a prospect into a customer only when the quote converts', async () => {
    const prospectQuote = (await api.post('/api/v1/quotations', {
      factoryId: factory.id, quotationDate: '2026-06-06', validUntil: '2026-12-31',
      prospect: { name: 'Bhuasuni Traders', phone: '9861000222', state: 'Odisha' },
      lines: [{ productId: paver.id, quantity: 4, ratePaise: 5000 }],
    })).body.data;

    const res = await api.post(`/api/v1/quotations/${prospectQuote.id}/convert`, {});
    expect(res.status).toBe(201);
    const party = await Party.findOne({ where: { name: 'Bhuasuni Traders' } });
    expect(party).toBeTruthy();
    expect(party.partyType).toBe('CUSTOMER');
    expect(res.body.data.quotation.customerPartyId).toBe(party.id);
  });

  it('refuses to convert one that has expired, leaving it open', async () => {
    const expired = (await api.post('/api/v1/quotations', {
      factoryId: factory.id, quotationDate: '2026-06-01', validUntil: '2026-06-10',
      customerPartyId: customer.id, lines: [{ productId: paver.id, quantity: 1 }],
    })).body.data;

    const res = await api.post(`/api/v1/quotations/${expired.id}/convert`, {});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/expired/);
    const after = await Quotation.findByPk(expired.id);
    expect(after.status).toBe('DRAFT');

    const listed = await api.get('/api/v1/quotations', { page: 1, limit: 50, status: 'EXPIRED' });
    expect(listed.body.data.rows.map((q) => q.id)).toContain(expired.id);
    expect(listed.body.data.rows.find((q) => q.id === expired.id).isExpired).toBe(true);
  });
});
