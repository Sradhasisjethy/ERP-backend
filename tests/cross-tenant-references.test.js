/**
 * Regression tests for findings C8 and S3 of the 2026-10-09 review.
 *
 * C8: a foreign id in a request body was stored on the strength of the plain
 * database foreign key, which another tenant's row satisfies. Every later read
 * then `include`d that tenant's party, product or user. Each request below
 * links a second tenant's id and must be refused without writing anything.
 *
 * S3: a receipt's allocations were only checked against the receipt's own
 * plant, so a plant-restricted user could settle another plant's invoice.
 */
const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Lead, LeadActivity } = require('../src/api/crm/lead.model');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party, Department, Office,
  Expense, Receipt, PriceList, PaymentAllocation, SalesInvoice, AdGroup, AdGroupMember, UserFactory,
} = require('../src/models/index');

const PASSWORD = 'password123';

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

const REFUSED = [400, 404];
let T;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);

  const tenant = await Tenant.create({ name: 'Home Co', slug: 'xref-home', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Home Pvt Ltd', code: 'HC' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'ACTIVE' });
  const plantA = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant A', code: 'PA', state: 'Odisha', allowNegativeCash: true });  // the expense control pays from an empty till
  const plantB = await Factory.create({ tenantId, organizationId: org.id, name: 'Plant B', code: 'PB', state: 'Odisha' });

  const admin = await User.create(
    { tenantId, email: 'admin@xref.test', passwordHash, firstName: 'A', lastName: 'A', role: 'PLATFORM_ADMIN', status: 'ACTIVE' },
    { validate: false }
  );
  const cashier = await User.create(
    { tenantId, email: 'cashier@xref.test', passwordHash, firstName: 'C', lastName: 'C', role: 'EMPLOYEE', status: 'ACTIVE' },
    { validate: false }
  );
  const group = await AdGroup.create({ tenantId, name: 'Plant A cashiers', permissions: ['RECEIPT_CREATE', 'RECEIPT_READ'] });
  await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: cashier.id });
  await UserFactory.create({ tenantId, userId: cashier.id, factoryId: plantA.id });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  const product = await Product.create({ tenantId, uomId: uom.id, name: 'Pipe', code: 'FG-P', productType: 'FINISHED_GOOD' });
  const customer = await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Home Customer', state: 'Odisha' });
  const department = await Department.create({ tenantId, organizationId: org.id, name: 'Sales', code: 'SAL' });

  // Posted invoices are built directly: allocation only reads status, plant,
  // customer and total, and the full order-to-invoice chain adds nothing here.
  const invoice = (factory, invoiceNumber) => SalesInvoice.create({
    tenantId, factoryId: factory.id, invoiceNumber, customerPartyId: customer.id,
    invoiceDate: '2026-08-17', subtotalPaise: 10000, totalPaise: 10000,
  });
  const invoiceA = await invoice(plantA, 'INV-A-1');
  const invoiceB = await invoice(plantB, 'INV-B-1');

  // The other tenant, whose ids must never be linkable from Home Co.
  const rival = await Tenant.create({ name: 'Rival Co', slug: 'xref-rival', status: 'active' });
  const rivalOrg = await Organization.create({ tenantId: rival.id, name: 'Rival Pvt Ltd', code: 'RC' });
  const rivalUom = await Uom.create({ tenantId: rival.id, name: 'Numbers', code: 'NOS-R' });
  const rivalProduct = await Product.create({ tenantId: rival.id, uomId: rivalUom.id, name: 'Rival Pipe', code: 'FG-R', productType: 'FINISHED_GOOD' });
  const rivalParty = await Party.create({ tenantId: rival.id, partyType: 'CUSTOMER', name: 'Rival Customer', state: 'Odisha' });
  const rivalUser = await User.create(
    { tenantId: rival.id, email: 'user@xref-rival.test', passwordHash, firstName: 'R', lastName: 'R', role: 'EMPLOYEE', status: 'ACTIVE' },
    { validate: false }
  );
  const rivalDepartment = await Department.create({ tenantId: rival.id, organizationId: rivalOrg.id, name: 'Rival Sales', code: 'RSAL' });

  T = {
    org, plantA, plantB, admin, product, customer, department, invoiceA, invoiceB,
    rivalProduct, rivalParty, rivalUser, rivalDepartment,
  };
  T.adminCookie = await loginAs('admin@xref.test');
  T.cashierCookie = await loginAs('cashier@xref.test');
});

afterAll(async () => {
  await sequelize.close();
});

const post = (path, body, cookie = T.adminCookie) => request(app).post(path).set('Cookie', cookie).send(body);

describe('C8: another tenant\'s ids cannot be linked', () => {
  it('refuses an expense paid to another tenant\'s party', async () => {
    const body = { factoryId: T.plantA.id, expenseDate: '2026-08-20', category: 'Diesel', mode: 'CASH', amountPaise: 1500 };
    const res = await post('/api/v1/expenses', { ...body, paidToPartyId: T.rivalParty.id });
    expect(REFUSED).toContain(res.status);
    expect(await Expense.unscoped().count({ where: { paidToPartyId: T.rivalParty.id } })).toBe(0);

    // Positive control: the same request with this tenant's party posts.
    const ok = await post('/api/v1/expenses', { ...body, paidToPartyId: T.customer.id });
    expect(ok.status).toBe(201);
  });

  it('refuses a receipt from another tenant\'s customer, even with no allocations', async () => {
    const res = await post('/api/v1/receipts', {
      factoryId: T.plantA.id, customerPartyId: T.rivalParty.id, receiptDate: '2026-08-18', modes: [{ mode: 'CASH', amountPaise: 500 }],
    });
    expect(REFUSED).toContain(res.status);
    expect(await Receipt.unscoped().count({ where: { customerPartyId: T.rivalParty.id } })).toBe(0);
  });

  it('refuses a price list item for another tenant\'s product', async () => {
    const body = { name: 'Rival leak list', priceType: 'RETAIL', items: [{ productId: T.rivalProduct.id, ratePaise: 100 }] };
    const res = await post('/api/v1/price-lists', body);
    expect(REFUSED).toContain(res.status);
    expect(await PriceList.unscoped().count({ where: { name: 'Rival leak list' } })).toBe(0);

    const ok = await post('/api/v1/price-lists', { ...body, name: 'Home list', items: [{ productId: T.product.id, ratePaise: 100 }] });
    expect(ok.status).toBe(201);
  });

  it('refuses a price list for another tenant\'s party', async () => {
    const res = await post('/api/v1/price-lists', { name: 'Rival party list', priceType: 'PARTY_SPECIFIC', partyId: T.rivalParty.id });
    expect(REFUSED).toContain(res.status);
    expect(await PriceList.unscoped().count({ where: { name: 'Rival party list' } })).toBe(0);
  });

  it('refuses a lead owned by, or a task assigned to, another tenant\'s user', async () => {
    const res = await post('/api/v1/crm/leads', { name: 'Leaky Lead', ownerId: T.rivalUser.id });
    expect(REFUSED).toContain(res.status);
    expect(await Lead.unscoped().count({ where: { ownerId: T.rivalUser.id } })).toBe(0);

    const lead = await post('/api/v1/crm/leads', { name: 'Home Lead', ownerId: T.admin.id });
    expect(lead.status).toBe(201);

    const task = await post(`/api/v1/crm/leads/${lead.body.data.id}/activities`, {
      type: 'TASK', subject: 'Call back', dueDate: '2026-10-20', assignedTo: T.rivalUser.id,
    });
    expect(REFUSED).toContain(task.status);
    expect(await LeadActivity.unscoped().count({ where: { assignedTo: T.rivalUser.id } })).toBe(0);
  });

  it('refuses an office linked to another tenant\'s department', async () => {
    const body = {
      organizationId: T.org.id, name: 'Branch', code: 'BR-X', address: '1 Road', city: 'Cuttack',
      state: 'Odisha', pincode: '753001', country: 'India',
    };
    const res = await post('/api/v1/offices', { ...body, departmentIds: [T.rivalDepartment.id] });
    expect(REFUSED).toContain(res.status);
    expect(await Office.unscoped().count({ where: { code: 'BR-X' } })).toBe(0);

    const ok = await post('/api/v1/offices', { ...body, code: 'BR-OK', departmentIds: [T.department.id] });
    expect(ok.status).toBe(201);
  });
});

describe('S3: a receipt can only settle invoices of plants the caller can see', () => {
  const receipt = (invoiceId) => ({
    factoryId: T.plantA.id, customerPartyId: T.customer.id, receiptDate: '2026-08-18',
    modes: [{ mode: 'CASH', amountPaise: 1000 }], allocations: [{ invoiceId, allocatedAmountPaise: 1000 }],
  });

  it('404s an allocation to another plant\'s invoice for a plant-restricted user', async () => {
    const res = await post('/api/v1/receipts', receipt(T.invoiceB.id), T.cashierCookie);
    expect(res.status).toBe(404);
    expect(await PaymentAllocation.unscoped().count({ where: { invoiceId: T.invoiceB.id } })).toBe(0);
  });

  it('still lets that user settle an invoice of their own plant', async () => {
    const res = await post('/api/v1/receipts', receipt(T.invoiceA.id), T.cashierCookie);
    expect(res.status).toBe(201);
    expect(await PaymentAllocation.unscoped().count({ where: { invoiceId: T.invoiceA.id } })).toBe(1);
  });
});
