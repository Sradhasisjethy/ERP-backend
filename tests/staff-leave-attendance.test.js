const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, Factory, AdGroup, AdGroupMember } = require('../src/models/index');

/**
 * Staff leave and attendance.
 *
 * What matters: leave cannot be double-booked, nobody approves their own,
 * balances count only approved days, and the day's roster already knows who is
 * on leave so they are not marked absent by hand.
 */

const PASSWORD = 'password123';
let adminCookie;
let clerkCookie;
let admin;
let clerk;
let factory;
let tenantId;
let casualLeave;
let unpaidLeave;

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const as = (cookie) => ({
  get: (url, query) => request(app).get(url).set('Cookie', cookie).query(query || {}),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body),
  put: (url, body) => request(app).put(url).set('Cookie', cookie).send(body),
});

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'HR Precast', slug: 'hr-precast', status: 'active' });
  tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'HR Precast Pvt Ltd', code: 'HPL' });
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  admin = await User.create(
    { tenantId, email: 'admin@hr.co', passwordHash, firstName: 'Asha', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  clerk = await User.create(
    { tenantId, email: 'clerk@hr.co', passwordHash, firstName: 'Raju', lastName: 'Clerk', role: 'EMPLOYEE', employeeCode: 'EMP-002' },
    { validate: false }
  );
  factory = await Factory.create({ tenantId, organizationId: org.id, name: 'HR Plant', code: 'HRP', state: 'Odisha' });

  // The clerk may apply for leave and mark attendance, but not approve.
  const group = await AdGroup.create({
    tenantId, name: 'Office staff',
    permissions: ['LEAVE_READ', 'LEAVE_CREATE', 'LEAVE_MODIFY', 'STAFF_ATTENDANCE_READ', 'STAFF_ATTENDANCE_CREATE'],
  });
  await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: clerk.id });
  // Attendance can name the site it was taken at, and BR-29 applies to that
  // like anywhere else: the clerk marks the plant they are assigned to.
  const { UserFactory } = require('../src/api/factory/userFactory.model');
  await UserFactory.create({ tenantId, userId: clerk.id, factoryId: factory.id });

  adminCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'admin@hr.co', password: PASSWORD }), 'accessToken');
  clerkCookie = extractCookie(await request(app).post('/api/v1/auth/login').send({ email: 'clerk@hr.co', password: PASSWORD }), 'accessToken');
});

afterAll(async () => {
  await sequelize.close();
});

describe('Leave types', () => {
  it('sets up casual and unpaid leave', async () => {
    const casual = await as(adminCookie).post('/api/v1/hr/leave-types', { code: 'cl', name: 'Casual Leave', daysPerYear: 12 });
    expect(casual.status).toBe(201);
    expect(casual.body.data.code).toBe('CL');
    casualLeave = casual.body.data;

    const unpaid = await as(adminCookie).post('/api/v1/hr/leave-types', { code: 'LWP', name: 'Leave Without Pay', daysPerYear: 0, isPaid: false });
    expect(unpaid.status).toBe(201);
    unpaidLeave = unpaid.body.data;
  });

  it('refuses a duplicate code', async () => {
    const res = await as(adminCookie).post('/api/v1/hr/leave-types', { code: 'CL', name: 'Casual again' });
    expect(res.status).toBe(409);
  });
});

describe('Applying for leave', () => {
  let request1;

  it('books three days', async () => {
    const res = await as(clerkCookie).post('/api/v1/hr/leave-requests', {
      employeeId: clerk.id, leaveTypeId: casualLeave.id, fromDate: '2026-10-05', toDate: '2026-10-07', reason: 'Family function',
    });
    expect(res.status).toBe(201);
    request1 = res.body.data;
    expect(request1.days).toBe(3);
    expect(request1.status).toBe('PENDING');
  });

  it('refuses leave that overlaps leave already applied for', async () => {
    const res = await as(clerkCookie).post('/api/v1/hr/leave-requests', {
      employeeId: clerk.id, leaveTypeId: unpaidLeave.id, fromDate: '2026-10-07', toDate: '2026-10-09',
    });
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/overlaps/);
  });

  it('refuses more days than the dates span, and dates that run backwards', async () => {
    expect((await as(clerkCookie).post('/api/v1/hr/leave-requests', {
      employeeId: clerk.id, leaveTypeId: casualLeave.id, fromDate: '2026-11-02', toDate: '2026-11-02', days: 2,
    })).status).toBe(400);
    expect((await as(clerkCookie).post('/api/v1/hr/leave-requests', {
      employeeId: clerk.id, leaveTypeId: casualLeave.id, fromDate: '2026-11-05', toDate: '2026-11-01',
    })).status).toBe(400);
  });

  it('takes a half day', async () => {
    const res = await as(clerkCookie).post('/api/v1/hr/leave-requests', {
      employeeId: clerk.id, leaveTypeId: casualLeave.id, fromDate: '2026-11-02', toDate: '2026-11-02', days: 0.5,
    });
    expect(res.status).toBe(201);
    expect(res.body.data.days).toBe(0.5);
  });

  it('will not let the clerk approve anything', async () => {
    const res = await as(clerkCookie).put(`/api/v1/hr/leave-requests/${request1.id}/decision`, { status: 'APPROVED' });
    expect(res.status).toBe(403);
  });

  it('is approved by someone else', async () => {
    const res = await as(adminCookie).put(`/api/v1/hr/leave-requests/${request1.id}/decision`, { status: 'APPROVED', note: 'Enjoy' });
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('APPROVED');
    expect(res.body.data.decidedBy).toBe(admin.id);
  });

  it('will not decide the same request twice', async () => {
    const res = await as(adminCookie).put(`/api/v1/hr/leave-requests/${request1.id}/decision`, { status: 'REJECTED', note: 'Changed my mind' });
    expect(res.status).toBe(400);
  });

  it('refuses a rejection with no reason', async () => {
    const applied = await as(clerkCookie).post('/api/v1/hr/leave-requests', {
      employeeId: clerk.id, leaveTypeId: casualLeave.id, fromDate: '2026-12-01', toDate: '2026-12-01',
    });
    const res = await as(adminCookie).put(`/api/v1/hr/leave-requests/${applied.body.data.id}/decision`, { status: 'REJECTED' });
    expect(res.status).toBe(400);
  });

  it('will not let an admin approve their own leave', async () => {
    const own = await as(adminCookie).post('/api/v1/hr/leave-requests', {
      employeeId: admin.id, leaveTypeId: casualLeave.id, fromDate: '2027-01-05', toDate: '2027-01-05',
    });
    const res = await as(adminCookie).put(`/api/v1/hr/leave-requests/${own.body.data.id}/decision`, { status: 'APPROVED' });
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/your own/);
  });
});

describe('Balances', () => {
  it('counts approved days against the quota and shows pending separately', async () => {
    const res = await as(adminCookie).get('/api/v1/hr/leave-balances', { employeeId: clerk.id, date: '2026-10-10' });
    expect(res.status).toBe(200);
    expect(res.body.data.leaveYear).toBe('2026-27');

    const casual = res.body.data.balances.find((b) => b.code === 'CL');
    expect(casual.allowedDays).toBe(12);
    expect(casual.takenDays).toBe(3);
    expect(casual.pendingDays).toBe(1.5); // the half day and the December day
    expect(casual.remainingDays).toBe(9);

    // Leave without a yearly quota has no remaining figure to report.
    expect(res.body.data.balances.find((b) => b.code === 'LWP').remainingDays).toBeNull();
  });
});

describe('Attendance', () => {
  it('offers a roster that already knows who is on leave', async () => {
    const res = await as(adminCookie).get('/api/v1/hr/attendance/roster', { date: '2026-10-06' });
    expect(res.status).toBe(200);
    const row = res.body.data.rows.find((r) => r.employeeId === clerk.id);
    expect(row.approvedLeave.code).toBe('CL');
    expect(row.suggestedStatus).toBe('ON_LEAVE');
    expect(res.body.data.rows.find((r) => r.employeeId === admin.id).suggestedStatus).toBe('PRESENT');
  });

  it('marks a day for everyone at once', async () => {
    const res = await as(clerkCookie).post('/api/v1/hr/attendance', {
      attendanceDate: '2026-10-06', factoryId: factory.id,
      entries: [
        { employeeId: admin.id, status: 'PRESENT', inTime: '09:15', outTime: '18:00' },
        { employeeId: clerk.id, status: 'ON_LEAVE' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.data.marked).toBe(2);
  });

  it('corrects a mark rather than adding a second one', async () => {
    await as(clerkCookie).post('/api/v1/hr/attendance', {
      attendanceDate: '2026-10-06', entries: [{ employeeId: admin.id, status: 'HALF_DAY', note: 'Left after lunch' }],
    });
    const res = await as(adminCookie).get('/api/v1/hr/attendance', { page: 1, limit: 50, employeeId: admin.id, from: '2026-10-06', to: '2026-10-06' });
    expect(res.body.data.rows).toHaveLength(1);
    expect(res.body.data.rows[0].status).toBe('HALF_DAY');
  });

  it('refuses a time that is not a time', async () => {
    const res = await as(clerkCookie).post('/api/v1/hr/attendance', {
      attendanceDate: '2026-10-07', entries: [{ employeeId: admin.id, status: 'PRESENT', inTime: '9am' }],
    });
    expect(res.status).toBe(400);
  });

  it('summarises the month into days worked, on leave and off', async () => {
    await as(clerkCookie).post('/api/v1/hr/attendance', {
      attendanceDate: '2026-10-08',
      entries: [{ employeeId: admin.id, status: 'PRESENT' }, { employeeId: clerk.id, status: 'WEEKLY_OFF' }],
    });
    const res = await as(adminCookie).get('/api/v1/hr/attendance/summary', { from: '2026-10-01', to: '2026-10-31' });
    expect(res.status).toBe(200);
    const adminRow = res.body.data.rows.find((r) => r.employeeId === admin.id);
    expect(adminRow.workedDays).toBe(1.5); // one half day, one full day
    const clerkRow = res.body.data.rows.find((r) => r.employeeId === clerk.id);
    expect(clerkRow.leaveDays).toBe(1);
    expect(clerkRow.offDays).toBe(1);
  });
});
