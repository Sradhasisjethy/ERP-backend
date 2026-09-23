const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, Factory, FinancialYear, Uom, Product, HsnCode, Party } = require('../src/models/index');

/**
 * Leads, follow-ups, and the line from an enquiry to an order.
 *
 * The pipeline only means something if its stages are set by what happened:
 * QUOTED comes from raising a quotation against the lead, WON from converting
 * it into a customer. Neither can be picked by hand.
 */

const PASSWORD = 'password123';
let cookie;
let factory;
let paver;
let salesman;

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
  const tenant = await Tenant.create({ name: 'Lead Precast', slug: 'lead-precast', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Lead Precast Pvt Ltd', code: 'LPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  salesman = await User.create(
    { tenantId, email: 'admin@leads.co', passwordHash, firstName: 'Sunil', lastName: 'Sales', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Lead Plant', code: 'LED', state: 'Odisha' });
  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-LED' });
  const hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast concrete', gstRatePercent: 18 });
  paver = await Product.create({ tenantId, uomId: uom.id, hsnId: hsn.id, name: 'Paver Led', code: 'FG-PAV-LED', productType: 'FINISHED_GOOD', curingDays: 0, sellingPricePaise: 5000 });

  cookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@leads.co', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('Taking an enquiry', () => {
  let lead;

  it('records it with who owns it', async () => {
    const res = await api.post('/api/v1/crm/leads', {
      name: 'Konark Infra Projects', contactName: 'Bikash Nayak', phone: '9861234567',
      source: 'SITE_VISIT', city: 'Puri', state: 'Odisha',
      estimatedValuePaise: 25000000, expectedCloseDate: '2026-11-30',
      requirement: '600mm RCC pipes for a drainage contract',
    });
    expect(res.status).toBe(201);
    lead = res.body.data;
    expect(lead.leadNumber).toMatch(/^LD\//);
    expect(lead.status).toBe('NEW');
    expect(lead.ownerId).toBe(salesman.id);
    expect(lead.isOpen).toBe(true);
  });

  it('moves to contacted as soon as someone calls', async () => {
    const res = await api.post(`/api/v1/crm/leads/${lead.id}/activities`, {
      type: 'CALL', subject: 'Introductory call', detail: 'Wants rates for 200 pipes',
    });
    expect(res.status).toBe(201);
    const after = await api.get(`/api/v1/crm/leads/${lead.id}`);
    expect(after.body.data.status).toBe('CONTACTED');
    expect(after.body.data.activities).toHaveLength(1);
  });

  it('keeps a task with a due date, and lists it as a follow-up', async () => {
    const task = await api.post(`/api/v1/crm/leads/${lead.id}/activities`, {
      type: 'TASK', subject: 'Send the rate list', dueDate: '2026-01-05', assignedTo: salesman.id,
    });
    expect(task.status).toBe(201);

    const pending = await api.get('/api/v1/crm/tasks');
    expect(pending.status).toBe(200);
    const row = pending.body.data.find((t) => t.id === task.body.data.id);
    expect(row.lead.leadNumber).toBe(lead.leadNumber);
    expect(row.isOverdue).toBe(true); // due in January, and it is September

    const done = await api.put(`/api/v1/crm/activities/${task.body.data.id}/complete`);
    expect(done.status).toBe(200);
    expect((await api.get('/api/v1/crm/tasks')).body.data.map((t) => t.id)).not.toContain(task.body.data.id);
  });

  it('will not let anyone simply declare it won or quoted', async () => {
    for (const status of ['WON', 'QUOTED']) {
      const res = await api.put(`/api/v1/crm/leads/${lead.id}/status`, { status });
      expect(res.status).toBe(400);
    }
    const qualified = await api.put(`/api/v1/crm/leads/${lead.id}/status`, { status: 'QUALIFIED' });
    expect(qualified.status).toBe(200);
    expect(qualified.body.data.status).toBe('QUALIFIED');
  });

  it('moves to quoted when a quotation is raised against it', async () => {
    const quote = await api.post('/api/v1/quotations', {
      factoryId: factory.id, quotationDate: '2026-09-20', validUntil: '2026-12-31',
      prospect: { name: 'Konark Infra Projects', phone: '9861234567', state: 'Odisha' },
      leadId: lead.id,
      lines: [{ productId: paver.id, quantity: 200 }],
    });
    expect(quote.status).toBe(201);
    expect(quote.body.data.leadId).toBe(lead.id);

    const after = await api.get(`/api/v1/crm/leads/${lead.id}`);
    expect(after.body.data.status).toBe('QUOTED');
  });

  it('becomes a customer when it is won', async () => {
    const res = await api.post(`/api/v1/crm/leads/${lead.id}/convert`, {});
    expect(res.status).toBe(201);
    expect(res.body.data.lead.status).toBe('WON');
    expect(res.body.data.customer.name).toBe('Konark Infra Projects');
    expect(res.body.data.customer.partyType).toBe('CUSTOMER');

    const party = await Party.findByPk(res.body.data.customer.id);
    expect(party.phone).toBe('9861234567');
    expect((await api.get(`/api/v1/crm/leads/${lead.id}`)).body.data.customerPartyId).toBe(party.id);
  });

  it('will not convert or edit a won lead twice', async () => {
    expect((await api.post(`/api/v1/crm/leads/${lead.id}/convert`, {})).status).toBe(400);
    expect((await api.put(`/api/v1/crm/leads/${lead.id}`, { phone: '9999999999' })).status).toBe(400);
  });
});

describe('Losing one', () => {
  let lead;

  beforeAll(async () => {
    lead = (await api.post('/api/v1/crm/leads', { name: 'Bhadrak Builders', source: 'PHONE', estimatedValuePaise: 5000000 })).body.data;
  });

  it('needs a reason', async () => {
    expect((await api.put(`/api/v1/crm/leads/${lead.id}/status`, { status: 'LOST' })).status).toBe(400);
    const res = await api.put(`/api/v1/crm/leads/${lead.id}/status`, { status: 'LOST', reason: 'Went with a local supplier on price' });
    expect(res.status).toBe(200);
    expect(res.body.data.lostReason).toMatch(/local supplier/);
    expect(res.body.data.isOpen).toBe(false);
  });

  it('shows the pipeline by stage, with what is still open', async () => {
    const res = await api.get('/api/v1/crm/pipeline');
    expect(res.status).toBe(200);
    const byStatus = Object.fromEntries(res.body.data.stages.map((s) => [s.status, s]));
    expect(byStatus.WON.count).toBe(1);
    expect(byStatus.LOST.count).toBe(1);
    expect(byStatus.LOST.valuePaise).toBe(5000000);
    // Everything is closed now, so nothing is left open.
    expect(res.body.data.openCount).toBe(0);
    expect(res.body.data.openValuePaise).toBe(0);
  });

  it('filters the list to open leads only', async () => {
    const fresh = await api.post('/api/v1/crm/leads', { name: 'Jajpur Roads Pvt Ltd', source: 'TENDER', estimatedValuePaise: 12000000 });
    expect(fresh.status).toBe(201);

    const res = await api.get('/api/v1/crm/leads', { page: 1, limit: 50, openOnly: 'true' });
    expect(res.body.data.rows.map((l) => l.name)).toEqual(['Jajpur Roads Pvt Ltd']);

    const pipeline = await api.get('/api/v1/crm/pipeline');
    expect(pipeline.body.data.openValuePaise).toBe(12000000);
  });
});
