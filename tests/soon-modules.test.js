/**
 * The six sidebar entries that were marked "soon".
 *
 * Four were screens over data that already existed (reservations, material
 * consumption, production orders, production sheets); one is a new master
 * (vehicles); one is a display preference (navigation).
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product,
  MixDesign, MixDesignLine, Party,
} = require('../src/models/index');

const PASSWORD = 'password123';
let adminCookie;
let factory;
let cement;
let slab;
let vendor;
let customer;
let transporter;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Soon Co', slug: 'soon-co', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Soon Co Ltd', code: 'SC' });
  await User.create(
    { tenantId, email: 'admin@soon.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'A', lastName: 'B', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Soon Plant', code: 'SC-FAC', varianceThresholdPercent: 5 });

  vendor = await Party.create({ tenantId, name: 'Soon Vendor', code: 'V-SC', partyType: 'VENDOR', status: 'active' });
  customer = await Party.create({ tenantId, name: 'Soon Customer', code: 'C-SC', partyType: 'CUSTOMER', status: 'active' });
  transporter = await Party.create({ tenantId, name: 'Soon Transport', code: 'T-SC', partyType: 'VENDOR', status: 'active' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-SC' });
  cement = await Product.create({ tenantId, uomId: uom.id, name: 'Cement SC', code: 'RM-CEM-SC', productType: 'RAW_MATERIAL', curingDays: 0 });
  slab = await Product.create({ tenantId, uomId: uom.id, name: 'Slab SC', code: 'FG-SLAB-SC', productType: 'FINISHED_GOOD', curingDays: 0 });

  const md = await MixDesign.create({
    tenantId, productId: slab.id, name: 'Slab SC v1', version: 1,
    status: 'ACTIVE', isActive: true, effectiveFrom: '2026-04-01',
  });
  await MixDesignLine.create({ tenantId, mixDesignId: md.id, rawMaterialProductId: cement.id, quantityPerUnit: 2, uomId: uom.id });

  adminCookie = extractCookie(
    await request(app).post('/api/v1/auth/login').send({ email: 'admin@soon.co', password: PASSWORD }),
    'accessToken'
  );

  // Stock, a run, and an order — so the read screens have something to show.
  await request(app).post('/api/v1/purchasing/receipts').set('Cookie', adminCookie)
    .send({ factoryId: factory.id, vendorPartyId: vendor.id, receiptDate: '2026-04-01',
            lines: [{ productId: cement.id, receivedQty: 500, ratePaise: 5000 }] });
});

afterAll(async () => {
  await sequelize.close();
});

describe('Vehicles — a real master behind a free-text field', () => {
  let vehicleId;

  it('creates a vehicle', async () => {
    const res = await request(app).post('/api/v1/vehicles').set('Cookie', adminCookie).send({
      registrationNumber: 'OD 02 AB 1234',
      vehicleType: 'TIPPER',
      capacityTonnes: 16.5,
      ownership: 'OWNED',
      driverName: 'R. Das',
    });
    expect(res.status).toBe(201);
    // Stored upper-cased and trimmed.
    expect(res.body.data.registrationNumber).toBe('OD 02 AB 1234');
    vehicleId = res.body.data.id;
  });

  it('refuses the same registration however it is spaced or punctuated', async () => {
    const res = await request(app).post('/api/v1/vehicles').set('Cookie', adminCookie)
      .send({ registrationNumber: 'od-02-ab-1234' });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already registered/i);
  });

  it('requires a transporter on a hired vehicle', async () => {
    const res = await request(app).post('/api/v1/vehicles').set('Cookie', adminCookie)
      .send({ registrationNumber: 'OD05XY9999', ownership: 'HIRED' });
    expect(res.status).toBe(400);
  });

  it('accepts a hired vehicle with its transporter', async () => {
    const res = await request(app).post('/api/v1/vehicles').set('Cookie', adminCookie)
      .send({ registrationNumber: 'OD05XY9999', ownership: 'HIRED', transporterPartyId: transporter.id });
    expect(res.status).toBe(201);
    expect(res.body.data.transporter?.name).toBe('Soon Transport');
  });

  it('clears the transporter when a hired vehicle becomes owned', async () => {
    const list = await request(app).get('/api/v1/vehicles?search=OD05XY9999').set('Cookie', adminCookie);
    const hired = list.body.data.rows[0];
    const res = await request(app).put(`/api/v1/vehicles/${hired.id}`).set('Cookie', adminCookie)
      .send({ ownership: 'OWNED' });
    expect(res.status).toBe(200);
    expect(res.body.data.transporterPartyId).toBeNull();
  });

  it('deactivates rather than deletes, so a signed challan keeps its record', async () => {
    const res = await request(app).delete(`/api/v1/vehicles/${vehicleId}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);

    const after = await request(app).get(`/api/v1/vehicles/${vehicleId}`).set('Cookie', adminCookie);
    expect(after.status).toBe(200);
    expect(after.body.data.status).toBe('inactive');
  });
});

describe('Reservations — the holds that decide what can be promised', () => {
  it('lists a hold raised by confirming a sales order', async () => {
    await request(app).post('/api/v1/production/entries').set('Cookie', adminCookie)
      .send({ factoryId: factory.id, productId: slab.id, productionDate: '2026-08-20', goodQty: 50 });

    const order = await request(app).post('/api/v1/sales/orders').set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-21',
              lines: [{ productId: slab.id, orderedQty: 20, ratePaise: 100 }] });
    expect(order.status).toBe(201);
    await request(app).put(`/api/v1/sales/orders/${order.body.data.id}/confirm`).set('Cookie', adminCookie).send({});

    const res = await request(app).get(`/api/v1/inventory/reservations?factoryId=${factory.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);

    const total = res.body.data.rows.reduce((sum, r) => sum + Number(r.quantity), 0);
    expect(total).toBe(20);
    // The hold names the lot it is against, which is the point.
    expect(res.body.data.rows[0].lot?.lotNumber).toBeTruthy();
  });

  it('shows only live holds by default', async () => {
    const res = await request(app).get(`/api/v1/inventory/reservations?factoryId=${factory.id}`).set('Cookie', adminCookie);
    expect(res.body.data.rows.every((r) => r.status === 'ACTIVE')).toBe(true);
  });
});

describe('Material consumption — where the raw material actually went', () => {
  it('lists consumption in its own right, not nested inside one entry', async () => {
    const res = await request(app).get(`/api/v1/production/consumptions?factoryId=${factory.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);

    const row = res.body.data.rows[0];
    expect(row.rawMaterial?.name).toBe('Cement SC');
    expect(row.productionEntry?.entryNumber).toBeTruthy();
    expect(Number(row.actualQty)).toBe(100); // 50 slabs x 2 cement
  });

  it('filters by raw material', async () => {
    const res = await request(app)
      .get(`/api/v1/production/consumptions?factoryId=${factory.id}&rawMaterialProductId=${cement.id}`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.every((r) => r.rawMaterialProductId === cement.id)).toBe(true);
  });
});

describe('Production orders — confirmed plan lines with fulfilment', () => {
  let planId;

  it('reports nothing until a plan is confirmed', async () => {
    const before = await request(app).get(`/api/v1/production/orders?factoryId=${factory.id}`).set('Cookie', adminCookie);
    expect(before.status).toBe(200);
    expect(before.body.data.rows).toHaveLength(0);
  });

  it('lists a confirmed line as an order with its target and progress', async () => {
    // A plan proposes work only where demand EXCEEDS stock, so the order has to
    // be bigger than the 50 slabs already on hand or nothing is proposed at all.
    const bigOrder = await request(app).post('/api/v1/sales/orders').set('Cookie', adminCookie)
      .send({ factoryId: factory.id, customerPartyId: customer.id, orderDate: '2026-08-22',
              lines: [{ productId: slab.id, orderedQty: 200, ratePaise: 100 }] });
    expect(bigOrder.status).toBe(201);
    await request(app).put(`/api/v1/sales/orders/${bigOrder.body.data.id}/confirm`).set('Cookie', adminCookie).send({});

    const proposal = await request(app).post('/api/v1/production/plans/generate').set('Cookie', adminCookie)
      .send({ factoryId: factory.id, planDate: '2026-08-22' });
    expect(proposal.status).toBe(201);
    planId = proposal.body.data.id;

    await request(app).put(`/api/v1/production/plans/${planId}/confirm`).set('Cookie', adminCookie).send({});

    const res = await request(app).get(`/api/v1/production/orders?factoryId=${factory.id}`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.length).toBeGreaterThan(0);

    const order = res.body.data.rows[0];
    expect(order.targetQty).toBeGreaterThan(0);
    expect(order.producedQty).toBe(0);
    expect(order.fulfilmentStatus).toBe('NOT_STARTED');
    expect(order.remainingQty).toBe(order.targetQty);
  });

  it('advances fulfilment as entries are posted against the line', async () => {
    const orders = await request(app).get(`/api/v1/production/orders?factoryId=${factory.id}`).set('Cookie', adminCookie);
    const order = orders.body.data.rows[0];

    const made = await request(app).post('/api/v1/production/entries').set('Cookie', adminCookie).send({
      factoryId: factory.id, productId: order.productId, productionDate: '2026-08-23',
      goodQty: 1, productionPlanLineId: order.id,
    });
    expect(made.status).toBe(201);

    const after = await request(app).get(`/api/v1/production/orders?factoryId=${factory.id}`).set('Cookie', adminCookie);
    const updated = after.body.data.rows.find((o) => o.id === order.id);
    expect(updated.producedQty).toBe(1);
    expect(updated.fulfilmentStatus).toBe('IN_PROGRESS');
  });

  it('prints a production sheet for the confirmed plan', async () => {
    const res = await request(app).get(`/api/v1/production/plans/${planId}/sheet`).set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.body.slice(0, 4).toString()).toBe('%PDF');
    // A job card goes to the batching crew, so it must never carry a rate (BR-07).
    expect(res.body.toString('latin1')).not.toMatch(/5000/);
  });

  it('refuses to print a sheet for a plan nobody has confirmed', async () => {
    const draft = await request(app).post('/api/v1/production/plans/generate').set('Cookie', adminCookie)
      .send({ factoryId: factory.id, planDate: '2026-08-24' });
    const res = await request(app).get(`/api/v1/production/plans/${draft.body.data.id}/sheet`).set('Cookie', adminCookie);
    expect(res.status).toBe(400);
  });
});

describe('Navigation — a tenant sidebar preference every user can read', () => {
  it('is null until someone customises it', async () => {
    const me = await request(app).get('/api/v1/auth/me').set('Cookie', adminCookie);
    expect(me.status).toBe(200);
    expect(me.body.data.navigationPreferences).toBeNull();
  });

  it('reaches every session once saved, not just users who can edit settings', async () => {
    const prefs = { hidden: ['Data Migration'], order: { Production: 1, Sales: 2 } };
    const saved = await request(app).put('/api/v1/settings/navigation').set('Cookie', adminCookie)
      .send({ value: prefs, category: 'ui' });
    expect(saved.status).toBe(200);

    const me = await request(app).get('/api/v1/auth/me').set('Cookie', adminCookie);
    expect(me.body.data.navigationPreferences).toEqual(prefs);
  });
});
