const request = require('supertest');
const bcrypt = require('bcryptjs');
const cls = require('cls-hooked');
const { NAMESPACE_NAME } = require('../src/core/tenantContext');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Factory, FinancialYear, Uom, Product, Party, AdGroup, AdGroupMember, Notification,
} = require('../src/models/index');
const { WebPermissions } = require('../src/utils/constants');
const { NotificationsService } = require('../src/api/notifications/notifications.service');
const { StockLedgerService } = require('../src/api/inventory/stockLedger.service');
const { runNightly, promoteCuredLots, classifyAgeing, checkLedgerConsistency } = require('../src/jobs/nightly');

const PASSWORD = 'password123';
let adminCookie;
let clerkCookie;
let tenantId;
let factory;
let finishedGood;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const runInTenantContext = (fn) => {
  const session = cls.getNamespace(NAMESPACE_NAME) || cls.createNamespace(NAMESPACE_NAME);
  return session.runAndReturn(() => {
    session.set('tenantId', tenantId);
    return fn();
  });
};

const seedLot = ({ lotNumber, originDate, curingDaysOverride, quantity }) =>
  runInTenantContext(() =>
    sequelize.transaction(async (transaction) => {
      const lot = await StockLedgerService.createLot({
        factoryId: factory.id, productId: finishedGood.id, lotNumber, originType: 'PRODUCTION',
        originId: factory.id, originDate, curingDaysOverride, quantity, transaction,
      });
      await StockLedgerService.postEntry({
        factoryId: factory.id, productId: finishedGood.id, lotId: lot.id, movementType: 'PRODUCTION_IN',
        direction: 'IN', quantity, referenceType: 'Seed', referenceId: factory.id, transaction,
      });
      return lot;
    })
  );

beforeAll(async () => {
  await resetDatabase();

  const tenant = await Tenant.create({ name: 'Bhuasuni Precast', slug: 'bhuasuni-notif', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Bhuasuni Precast Pvt Ltd', code: 'BPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  await User.create({ tenantId, email: 'admin@notif-test.co', passwordHash, firstName: 'Admin', lastName: 'User', role: 'PLATFORM_ADMIN' }, { validate: false });

  const clerk = await User.create({ tenantId, email: 'clerk@notif-test.co', passwordHash, firstName: 'Clerk', lastName: 'User', role: 'EMPLOYEE' }, { validate: false });
  const group = await AdGroup.create({ tenantId, name: 'Ops', permissions: [WebPermissions.INVENTORY_READ] });
  await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: clerk.id });

  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true });
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'Notif Factory', code: 'NTF-FAC' });

  const uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS-NTF' });
  finishedGood = await Product.create({
    tenantId, uomId: uom.id, name: 'Notif Slab', code: 'FG-NTF', productType: 'FINISHED_GOOD',
    curingDays: 14, slowMovingDays: 120, deadStockDays: 180, alertBeforeDays: 30,
  });
  await Party.create({ tenantId, partyType: 'CUSTOMER', name: 'Notif Customer' });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@notif-test.co', password: PASSWORD }), 'accessToken');
  clerkCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'clerk@notif-test.co', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('FR-M24-5 Alert idempotency', () => {
  it('raises an alert once and suppresses exact repeats', async () => {
    const first = await runInTenantContext(() =>
      NotificationsService.raise({
        type: 'DEAD_STOCK', severity: 'HIGH', title: 'Dead stock',
        message: 'Lot X has been idle', dedupeKey: 'DEAD_STOCK:test-lot-1',
      })
    );
    expect(first).toBeTruthy();

    const second = await runInTenantContext(() =>
      NotificationsService.raise({
        type: 'DEAD_STOCK', severity: 'HIGH', title: 'Dead stock',
        message: 'Lot X has been idle', dedupeKey: 'DEAD_STOCK:test-lot-1',
      })
    );
    expect(second).toBeNull(); // suppressed, not duplicated

    const count = await runInTenantContext(() => Notification.count({ where: { dedupeKey: 'DEAD_STOCK:test-lot-1' } }));
    expect(count).toBe(1);
  });

  it('reports how many of a batch were genuinely new', async () => {
    const batch = [
      { type: 'DEAD_STOCK', title: 'A', message: 'a', dedupeKey: 'DEAD_STOCK:test-lot-1' }, // already raised
      { type: 'DEAD_STOCK', title: 'B', message: 'b', dedupeKey: 'DEAD_STOCK:test-lot-2' },
    ];
    const result = await runInTenantContext(() => NotificationsService.raiseMany(batch));
    expect(result).toEqual({ attempted: 2, created: 1, suppressedAsDuplicate: 1 });
  });
});

describe('Notification centre API', () => {
  it('lists notifications paginated, unread first', async () => {
    const res = await request(app).get('/api/v1/notifications').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.data.limit).toBe(10);
    expect(res.body.data.rows.length).toBeGreaterThan(0);
  });

  it('reports an unread count and clears it when marked read', async () => {
    const before = await request(app).get('/api/v1/notifications/unread-count').set('Cookie', adminCookie);
    expect(before.body.data.unread).toBeGreaterThan(0);

    const all = await request(app).put('/api/v1/notifications/read-all').set('Cookie', adminCookie);
    expect(all.status).toBe(200);

    const after = await request(app).get('/api/v1/notifications/unread-count').set('Cookie', adminCookie);
    expect(after.body.data.unread).toBe(0);
  });

  it('filters to unread only', async () => {
    await runInTenantContext(() =>
      NotificationsService.raise({ type: 'NEGATIVE_CASH', title: 'Cash', message: 'negative', dedupeKey: 'NEGATIVE_CASH:probe' })
    );
    const res = await request(app).get('/api/v1/notifications?unreadOnly=true').set('Cookie', adminCookie);
    expect(res.body.data.count).toBe(1);
    expect(res.body.data.rows[0].type).toBe('NEGATIVE_CASH');
  });

  it('masks money in alert metadata for a user without VIEW_RATES (BR-27)', async () => {
    await runInTenantContext(() =>
      NotificationsService.raise({
        type: 'OVERDUE_RECEIVABLE', title: 'Overdue', message: 'Invoice INV/0001 is 45 days overdue',
        metadata: { daysOverdue: 45, outstandingPaise: 123456 },
        dedupeKey: 'OVERDUE_RECEIVABLE:probe',
      })
    );

    const withRates = await request(app).get('/api/v1/notifications?type=OVERDUE_RECEIVABLE').set('Cookie', adminCookie);
    expect(withRates.body.data.rows[0].metadata.outstandingPaise).toBe(123456);

    const withoutRates = await request(app).get('/api/v1/notifications?type=OVERDUE_RECEIVABLE').set('Cookie', clerkCookie);
    expect(withoutRates.status).toBe(200);
    expect(withoutRates.body.data.rows[0].metadata.outstandingPaise).toBeNull();
    // Non-money context must survive — masking, not blanking.
    expect(withoutRates.body.data.rows[0].metadata.daysOverdue).toBe(45);
    // The amount must not be smuggled into the prose, which no field-level
    // mask can reach. (Document numbers may contain digits — this checks for
    // the actual value, not for digits in general.)
    expect(withoutRates.body.data.rows[0].message).not.toContain('123456');
  });
});

describe('Nightly jobs', () => {
  it('promotes cured lots and raises a curing-complete alert', async () => {
    // Produced 20 days ago with a 14-day cure: due for promotion.
    const originDate = new Date();
    originDate.setDate(originDate.getDate() - 20);
    const lot = await seedLot({ lotNumber: 'CURED-DUE', originDate: originDate.toISOString().slice(0, 10), curingDaysOverride: 14, quantity: 10 });

    // createLot anchors status to originDate, so a lot whose cure already
    // elapsed starts AVAILABLE — force it back to CURING to exercise the job.
    await runInTenantContext(() => lot.update({ status: 'CURING' }, { hooks: false }));

    const result = await runInTenantContext(promoteCuredLots);
    expect(result.promoted).toBeGreaterThan(0);

    await lot.reload();
    expect(lot.status).toBe('AVAILABLE');

    const alert = await runInTenantContext(() => Notification.findOne({ where: { dedupeKey: `CURING_COMPLETE:${lot.id}` } }));
    expect(alert).toBeTruthy();
  });

  it('classifies ageing and raises a dead-stock alert exactly once across two runs', async () => {
    const originDate = new Date();
    originDate.setDate(originDate.getDate() - 200); // past the 180-day dead threshold
    const lot = await seedLot({ lotNumber: 'DEAD-200', originDate: originDate.toISOString().slice(0, 10), curingDaysOverride: 0, quantity: 7 });

    await runInTenantContext(classifyAgeing);
    await lot.reload();
    expect(lot.ageingClass).toBe('DEAD');

    const afterSecondRun = await runInTenantContext(classifyAgeing);
    expect(afterSecondRun.suppressedAsDuplicate).toBeGreaterThan(0);

    const count = await runInTenantContext(() => Notification.count({ where: { dedupeKey: `DEAD_STOCK:${lot.id}` } }));
    expect(count).toBe(1);
  });

  it('detects ledger drift and raises a critical alert', async () => {
    const clean = await runInTenantContext(checkLedgerConsistency);
    expect(clean.discrepancies).toBe(0);

    const lot = await runInTenantContext(() => require('../src/models/index').StockLot.findOne({ where: { lotNumber: 'DEAD-200' } }));
    await runInTenantContext(() => lot.update({ qtyAvailable: Number(lot.qtyAvailable) + 42 }, { hooks: false }));

    const drifted = await runInTenantContext(checkLedgerConsistency);
    expect(drifted.discrepancies).toBe(1);

    const alert = await runInTenantContext(() =>
      Notification.findOne({ where: { type: 'LEDGER_BALANCE_DRIFT', entityId: lot.id } })
    );
    expect(alert).toBeTruthy();
    expect(alert.severity).toBe('CRITICAL');

    // Repair so the whole-batch run below starts from a clean ledger.
    await runInTenantContext(() => StockLedgerService.rebuildStockBalances({ factoryId: factory.id }));
  });

  it('runs the whole nightly batch without any job aborting the others', async () => {
    const report = await runNightly({ tenantId });
    const tenantReport = report[tenantId];

    expect(Object.keys(tenantReport)).toEqual(
      expect.arrayContaining([
        'promoteCuredLots', 'classifyAgeing', 'alertOverdueReceivables',
        'alertLateOrders', 'alertStaleReservations', 'alertNegativeCash', 'checkLedgerConsistency',
      ])
    );
    // No job reported an error.
    expect(Object.values(tenantReport).filter((r) => r && r.error)).toEqual([]);
  });
});
