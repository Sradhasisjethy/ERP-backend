/**
 * DPDP Act 2023 / DPDP Rules 2025: notice, consent, the rights of the people
 * whose data the ERP holds, breach reporting and retention.
 *
 * The privacy desk belongs to the application owner — the accounts named in
 * PLATFORM_OWNER_EMAILS — and spans every organisation. An organisation's own
 * administrators, even TENANT_OWNER and PLATFORM_ADMIN (which bypass every
 * permission), cannot reach it. Every user keeps My privacy.
 *
 * Synthetic people and numbers only.
 */
process.env.PLATFORM_OWNER_EMAILS = 'Owner@Platform.test, second-owner@platform.test';

const request = require('supertest');
const bcrypt = require('bcryptjs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { runInTenantContext } = require('./helpers/tenant');
const { AuditLog } = require('../src/api/audit/auditLog.model');
const { ErasureService } = require('../src/api/privacy/erasure.service');
const { runPrivacyDuties } = require('../src/jobs/nightly');
const {
  Tenant, User, Organization, FinancialYear, Party, Factory,
  ConsentRecord, DataPrincipalRequest, RetentionRule, Notification,
} = require('../src/models/index');
const { Lead } = require('../src/api/crm/lead.model');

const PASSWORD = 'password123';
const AADHAAR = '999911112222';

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

const as = (cookie) => ({
  get: (url, query) => request(app).get(url).set('Cookie', cookie).query(query || {}),
  post: (url, body) => request(app).post(url).set('Cookie', cookie).send(body || {}),
  put: (url, body) => request(app).put(url).set('Cookie', cookie).send(body || {}),
});

let T;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const user = (tenantId, email, extra = {}) =>
    User.create({ tenantId, email, passwordHash, firstName: 'Asha', lastName: email.split('@')[0], role: 'EMPLOYEE', status: 'ACTIVE', ...extra }, { validate: false });

  // The application owner's own organisation.
  const platform = await Tenant.create({ name: 'Platform Co', slug: 'platform-co', status: 'active' });
  // An ordinary role: being the owner is about who you are, not what role you hold.
  const ownerUser = await user(platform.id, 'owner@platform.test');

  // A customer organisation using the ERP.
  const tenant = await Tenant.create({ name: 'Privacy Precast', slug: 'privacy-precast', status: 'active' });
  const tenantId = tenant.id;
  const org = await Organization.create({ tenantId, name: 'Privacy Precast Pvt Ltd', code: 'PPL' });
  await FinancialYear.create({ tenantId, code: '2026-27', startDate: '2026-04-01', endDate: '2027-03-31', isCurrent: true, status: 'ACTIVE' });
  await Factory.create({ tenantId, organizationId: org.id, name: 'Plant', code: 'PRV', state: 'Odisha' });
  await user(tenantId, 'orgowner@precast.test', { role: 'TENANT_OWNER' });
  await user(tenantId, 'orgadmin@precast.test', { role: 'PLATFORM_ADMIN' });
  await user(tenantId, 'staff@precast.test', { phone: '9000000001', address: '12 Mill Road' });
  const leaver = await user(tenantId, 'leaver@precast.test', { phone: '9000000002', address: '7 Old Lane', status: 'INACTIVE' });

  const labour = await Party.create({
    tenantId, partyType: 'LABOUR', name: 'Ramesh Worker', code: 'LAB-0001', phone: '9111111111',
    aadhaarNumber: AADHAAR, bankAccountNumber: '000111222333', bankIfsc: 'TEST0000999', dateOfBirth: '1990-05-15',
  });
  const minor = await Party.create({
    tenantId, partyType: 'LABOUR', name: 'Young Helper', code: 'LAB-0002', dateOfBirth: '2012-01-01',
  });

  T = {
    tenantId, platformId: platform.id, ownerUser, labour, minor, leaver,
    owner: as(await loginAs('owner@platform.test')),
    orgOwner: as(await loginAs('orgowner@precast.test')),
    orgAdmin: as(await loginAs('orgadmin@precast.test')),
    staff: as(await loginAs('staff@precast.test')),
    anon: { get: (url) => request(app).get(url), post: (url, body) => request(app).post(url).send(body || {}) },
  };
});

afterAll(async () => {
  await sequelize.close();
});

describe('Who may use the privacy desk', () => {
  it("keeps every organisation's own administrators out, however senior", async () => {
    for (const client of [T.orgOwner, T.orgAdmin, T.staff]) {
      expect((await client.get('/api/v1/privacy/overview')).status).toBe(403);
      expect((await client.put('/api/v1/privacy/profile', { contactEmail: 'x@y.test' })).status).toBe(403);
      expect((await client.post('/api/v1/privacy/notices', {})).status).toBe(403);
    }
  });

  it('lets in the owner named in server config, matched without regard to case', async () => {
    expect((await T.owner.get('/api/v1/privacy/overview')).status).toBe(200);
    expect((await T.owner.get('/api/v1/auth/me')).body.data.isPlatformOwner).toBe(true);
    expect((await T.orgOwner.get('/api/v1/auth/me')).body.data.isPlatformOwner).toBe(false);
  });

  it('still gives every user their own privacy page', async () => {
    const me = await T.staff.get('/api/v1/privacy/me');
    expect(me.status).toBe(200);
    expect(me.body.data.acknowledgementPending).toBe(false); // nothing published yet
  });

  it('lists the organisations for the desk to choose between', async () => {
    const res = await T.owner.get('/api/v1/privacy/organisations');
    expect(res.body.data.map((o) => o.name)).toEqual(['Platform Co', 'Privacy Precast']);
  });
});

describe('The privacy notice (s.5)', () => {
  let draft;

  it('starts a draft from the starter template', async () => {
    const res = await T.owner.post('/api/v1/privacy/notices', {});
    expect(res.status).toBe(201);
    draft = res.body.data;
    expect(draft.status).toBe('DRAFT');
    expect(draft.version).toBe(1);
    expect(draft.purposes.map((p) => p.code)).toEqual(expect.arrayContaining(['EMPLOYMENT_ADMIN', 'SALES_FOLLOW_UP', 'MARKETING']));
  });

  it('will not publish until someone is named to answer for personal data (s.8(9))', async () => {
    const res = await T.owner.post(`/api/v1/privacy/notices/${draft.id}/publish`);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/privacy contact/i);
  });

  it('refuses a response time beyond the 90 days Rule 14 allows', async () => {
    const res = await T.owner.put('/api/v1/privacy/profile', { contactName: 'Priya Officer', contactEmail: 'privacy@platform.test', responseDays: 120 });
    expect(res.status).toBe(400);
  });

  it('publishes once the contact is set, and freezes what was published', async () => {
    const profile = await T.owner.put('/api/v1/privacy/profile', {
      contactName: 'Priya Officer', contactDesignation: 'Grievance Officer', contactEmail: 'privacy@platform.test', responseDays: 30,
    });
    expect(profile.status).toBe(200);
    const res = await T.owner.post(`/api/v1/privacy/notices/${draft.id}/publish`);
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('PUBLISHED');
    expect((await T.owner.put(`/api/v1/privacy/notices/${draft.id}`, { title: 'Changed after the fact' })).status).toBe(400);
  });

  it('keeps exactly one notice in force when a new version is published', async () => {
    const v2 = await T.owner.post('/api/v1/privacy/notices', {});
    expect(v2.body.data.version).toBe(2);
    await T.owner.post(`/api/v1/privacy/notices/${v2.body.data.id}/publish`);
    const all = (await T.owner.get('/api/v1/privacy/notices')).body.data;
    expect(all.filter((n) => n.status === 'PUBLISHED')).toHaveLength(1);
    expect(all.find((n) => n.version === 1).status).toBe('ARCHIVED');
  });

  it("is the same notice for every organisation's users, each acknowledging it once", async () => {
    const before = await T.staff.get('/api/v1/privacy/me');
    expect(before.body.data.acknowledgementPending).toBe(true);
    expect(before.body.data.notice.version).toBe(2);
    expect(before.body.data.profile.contactEmail).toBe('privacy@platform.test');
    expect((await T.staff.post('/api/v1/privacy/me/acknowledge')).status).toBe(200);
    expect((await T.staff.post('/api/v1/privacy/me/acknowledge')).status).toBe(200); // idempotent
    const after = await T.staff.get('/api/v1/privacy/me');
    expect(after.body.data.acknowledgementPending).toBe(false);
    expect(after.body.data.acknowledgement.noticeVersion).toBe(2);
  });
});

describe('The public page', () => {
  it('shows the owner\'s notice and contact without a sign-in or an organisation code', async () => {
    const res = await T.anon.get('/api/v1/public/privacy');
    expect(res.status).toBe(200);
    expect(res.body.data.contact.email).toBe('privacy@platform.test');
    expect(res.body.data.notice.purposes.length).toBeGreaterThan(0);
    expect(res.body.data.organisation).toBeUndefined();
  });

  it('takes a request, with no organisation yet, and discloses nothing back but a reference', async () => {
    const res = await T.anon.post('/api/v1/public/privacy/requests', {
      type: 'ACCESS', requesterName: 'Ramesh Worker', requesterPhone: '9111111111',
      requesterOrganisation: 'Privacy Precast, Bhubaneswar plant', details: 'What do you hold about me?',
    });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body.data).sort()).toEqual(['dueDate', 'reference']);
    expect(res.body.data.reference).toMatch(/^DPR\/\d{4}\/\d{4}$/);
    const stored = await DataPrincipalRequest.findOne({ where: { requestNumber: res.body.data.reference } });
    expect(stored.channel).toBe('PUBLIC_FORM');
    expect(stored.tenantId).toBeNull();
    expect(stored.requesterOrganisation).toBe('Privacy Precast, Bhubaneswar plant');
    T.publicRequestId = stored.id;
  });

  it('needs a way to reply', async () => {
    expect((await T.anon.post('/api/v1/public/privacy/requests', { type: 'GRIEVANCE', requesterName: 'No Contact' })).status).toBe(400);
  });

  it('drops a bot that fills the hidden field', async () => {
    const before = await DataPrincipalRequest.count();
    const res = await T.anon.post('/api/v1/public/privacy/requests', {
      type: 'GRIEVANCE', requesterName: 'Bot', requesterEmail: 'bot@spam.test', website: 'http://spam.test',
    });
    expect(res.status).toBe(201);
    expect(await DataPrincipalRequest.count()).toBe(before);
  });
});

describe('Consent (s.6) and children (s.9)', () => {
  let lead;
  let consent;

  beforeAll(async () => {
    const res = await T.orgOwner.post('/api/v1/crm/leads', {
      name: 'Konark Builders', contactName: 'Bikash Nayak', phone: '9861234567', email: 'bikash@konark.test', city: 'Puri',
    });
    expect(res.status).toBe(201);
    lead = res.body.data;
  });

  it('needs to know which organisation holds the person', async () => {
    const res = await T.owner.post('/api/v1/privacy/consents', {
      principalType: 'LEAD', principalId: lead.id, purposeCode: 'SALES_FOLLOW_UP', method: 'WRITTEN',
    });
    expect(res.status).toBe(400);
  });

  it('refuses consent for a purpose that rests on a legitimate use', async () => {
    const res = await T.owner.post('/api/v1/privacy/consents', {
      tenantId: T.tenantId, principalType: 'PARTY', principalId: T.labour.id, purposeCode: 'LABOUR_ENGAGEMENT', method: 'WRITTEN',
    });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/legitimate use/i);
  });

  it('records consent in the organisation that holds the record, against the notice version', async () => {
    const res = await T.owner.post('/api/v1/privacy/consents', {
      tenantId: T.tenantId, principalType: 'LEAD', principalId: lead.id, purposeCode: 'SALES_FOLLOW_UP', method: 'VERBAL_RECORDED', evidence: 'Call 14 Oct',
    });
    expect(res.status).toBe(201);
    consent = res.body.data;
    expect(consent.noticeVersion).toBe(2);
    expect(consent.principalName).toBe('Bikash Nayak');
    const row = await ConsentRecord.unscoped().findByPk(consent.id);
    expect(row.tenantId).toBe(T.tenantId);
    // Written as that organisation, by the owner: its audit trail says so.
    const audit = await AuditLog.findOne({ where: { tenantId: T.tenantId, entityId: consent.id, action: 'CREATE' } });
    expect(audit.userId).toBe(T.ownerUser.id);

    const list = await T.owner.get('/api/v1/privacy/consents');
    expect(list.body.data.rows[0].organisationName).toBe('Privacy Precast');

    const again = await T.owner.post('/api/v1/privacy/consents', {
      tenantId: T.tenantId, principalType: 'LEAD', principalId: lead.id, purposeCode: 'SALES_FOLLOW_UP', method: 'WRITTEN',
    });
    expect(again.status).toBe(409);
  });

  it("will not find a record in the wrong organisation", async () => {
    const res = await T.owner.post('/api/v1/privacy/consents', {
      tenantId: T.platformId, principalType: 'LEAD', principalId: lead.id, purposeCode: 'MARKETING', method: 'WRITTEN',
    });
    expect(res.status).toBe(404);
  });

  it("needs a verified guardian for an under-18's consent", async () => {
    const without = await T.owner.post('/api/v1/privacy/consents', {
      tenantId: T.tenantId, principalType: 'PARTY', principalId: T.minor.id, purposeCode: 'MARKETING', method: 'WRITTEN',
    });
    expect(without.status).toBe(400);
    expect(without.body.message).toMatch(/under 18/i);

    const overview = await T.owner.get('/api/v1/privacy/overview');
    expect(overview.body.data.unguardedMinors).toEqual([expect.objectContaining({ id: T.minor.id, organisationName: 'Privacy Precast' })]);

    const withGuardian = await T.owner.post('/api/v1/privacy/consents', {
      tenantId: T.tenantId, principalType: 'PARTY', principalId: T.minor.id, purposeCode: 'MARKETING', method: 'WRITTEN',
      guardianName: 'Parent Helper', guardianRelation: 'Father', guardianVerification: 'Aadhaar of parent seen in person',
    });
    expect(withGuardian.status).toBe(201);
    expect(withGuardian.body.data.isMinor).toBe(true);
  });

  it('opens an erasure request in that organisation when a lead withdraws its last consent', async () => {
    const res = await T.owner.put(`/api/v1/privacy/consents/${consent.id}/withdraw`, { reason: 'Asked not to be called' });
    expect(res.status).toBe(200);
    expect(res.body.data.consent.status).toBe('WITHDRAWN');
    expect(res.body.data.erasureRequest).toMatchObject({ type: 'ERASURE', principalType: 'LEAD', principalId: lead.id, tenantId: T.tenantId });
    T.leadErasure = res.body.data.erasureRequest;
    T.lead = lead;
  });
});

describe('Erasure (s.12)', () => {
  it('will not erase before the requester is verified', async () => {
    const res = await T.owner.post(`/api/v1/privacy/requests/${T.leadErasure.id}/complete`, {});
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/verify/i);
  });

  it('wipes the enquirer and their trail, keeping the business record', async () => {
    await T.owner.post(`/api/v1/privacy/requests/${T.leadErasure.id}/verify`, { note: 'Called back on the number we hold' });
    const res = await T.owner.post(`/api/v1/privacy/requests/${T.leadErasure.id}/complete`, {});
    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('COMPLETED');
    expect(res.body.data.organisationName).toBe('Privacy Precast');
    expect(res.body.data.outcome.fieldsErased).toEqual(expect.arrayContaining(['phone', 'email', 'contactName']));

    const lead = await Lead.findOne({ where: { id: T.lead.id, tenantId: T.tenantId } });
    expect(lead.phone).toBeNull();
    expect(lead.contactName).toBeNull();
    expect(lead.name).toMatch(/^Erased enquiry /);
    expect(lead.leadNumber).toBe(T.lead.leadNumber);

    // The audit trail must not be a second copy of what was erased.
    const trail = await AuditLog.findAll({ where: { tenantId: T.tenantId, entityId: T.lead.id } });
    expect(JSON.stringify(trail.map((r) => [r.beforeSnapshot, r.afterSnapshot]))).not.toMatch(/9861234567|bikash@konark/);
    expect(trail.some((r) => r.action === 'ERASE')).toBe(true);
  });

  it('matches a public request to its organisation and record, then erases a labourer', async () => {
    // A request from the public form starts with no organisation.
    const premature = await T.owner.put(`/api/v1/privacy/requests/${T.publicRequestId}`, { principalType: 'PARTY', principalId: T.labour.id });
    expect(premature.status).toBe(400);

    const linked = await T.owner.put(`/api/v1/privacy/requests/${T.publicRequestId}`, {
      tenantId: T.tenantId, principalType: 'PARTY', principalId: T.labour.id,
    });
    expect(linked.status).toBe(200);
    expect(linked.body.data.organisationName).toBe('Privacy Precast');

    const created = await T.owner.post('/api/v1/privacy/requests', {
      type: 'ERASURE', channel: 'WRITTEN', requesterName: 'Ramesh Worker', tenantId: T.tenantId, principalType: 'PARTY', principalId: T.labour.id,
    });
    expect(created.status).toBe(201);
    const id = created.body.data.id;
    await T.owner.post(`/api/v1/privacy/requests/${id}/verify`, { note: 'Signed letter, ID seen' });
    expect((await T.owner.post(`/api/v1/privacy/requests/${id}/complete`, {})).status).toBe(200);

    const party = await Party.scope('withSensitive').findOne({ where: { id: T.labour.id, tenantId: T.tenantId } });
    expect(party.name).toBe('Ramesh Worker');
    expect(party.aadhaarNumber).toBeNull();
    expect(party.bankAccountNumber).toBeNull();
    expect(party.dateOfBirth).toBeNull();
    expect(party.status).toBe('inactive');
  });

  it('refuses to erase someone still employed, and erases a leaver', async () => {
    const staffUser = await User.findOne({ where: { email: 'staff@precast.test' } });
    const refused = await runInTenantContext(T.tenantId, () => ErasureService.erase('USER', staffUser.id).catch((e) => e));
    expect(refused.message).toMatch(/Deactivate/);

    const erased = await runInTenantContext(T.tenantId, () => ErasureService.erase('USER', T.leaver.id));
    expect(erased.fieldsErased).toContain('phone');
    const leaver = await User.findOne({ where: { id: T.leaver.id } });
    expect(leaver.email).toMatch(/@erased\.invalid$/);
    expect(leaver.phone).toBeNull();
    expect(leaver.firstName).toBe('Asha');
  });
});

describe('Access (s.11)', () => {
  it('lets a user download what is held about them, and logs that it happened', async () => {
    const res = await T.staff.get('/api/v1/privacy/me/export');
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/attachment/);
    const body = JSON.parse(res.text);
    expect(body.personalData.email).toBe('staff@precast.test');
    expect(body.personalData.passwordHash).toBeUndefined();
    expect(body.purposes.every((p) => p.principalTypes.includes('USER'))).toBe(true);
    expect(body.dataFiduciaryContact.email).toBe('privacy@platform.test');

    const staffUser = await User.findOne({ where: { email: 'staff@precast.test' } });
    expect(await AuditLog.count({ where: { tenantId: T.tenantId, entityId: staffUser.id, action: 'EXPORT_PERSONAL_DATA' } })).toBe(1);
  });

  it('releases a request\'s data to the owner only once the requester is verified', async () => {
    const created = await T.owner.post('/api/v1/privacy/requests', {
      type: 'ACCESS', channel: 'EMAIL', requesterName: 'Young Helper', tenantId: T.tenantId, principalType: 'PARTY', principalId: T.minor.id,
    });
    const id = created.body.data.id;
    expect((await T.owner.get(`/api/v1/privacy/requests/${id}/export`)).status).toBe(400);
    await T.owner.post(`/api/v1/privacy/requests/${id}/verify`, { note: 'Guardian came in with ID' });
    const res = await T.owner.get(`/api/v1/privacy/requests/${id}/export`);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.text).personalData.name).toBe('Young Helper');
  });

  it('records a self-service request as already identified, in the user\'s organisation', async () => {
    const res = await T.staff.post('/api/v1/privacy/me/requests', { type: 'CORRECTION', details: 'My address changed' });
    expect(res.status).toBe(201);
    expect(res.body.data.identityVerifiedAt).not.toBeNull();
    expect(res.body.data.channel).toBe('IN_APP');
    expect(res.body.data.tenantId).toBe(T.tenantId);
  });

  it('lets a user nominate someone (s.14) and replace them', async () => {
    expect((await T.staff.put('/api/v1/privacy/me/nominee', { nominee: { nomineeName: 'Spouse One', relationship: 'Spouse' } })).status).toBe(200);
    await T.staff.put('/api/v1/privacy/me/nominee', { nominee: { nomineeName: 'Sibling Two', relationship: 'Brother' } });
    expect((await T.staff.get('/api/v1/privacy/me')).body.data.nominee.nomineeName).toBe('Sibling Two');
  });
});

describe('Breaches (s.8(6), Rule 7)', () => {
  let breach;

  it('starts the 72-hour clock from when the business became aware', async () => {
    const discoveredAt = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
    const res = await T.owner.post('/api/v1/privacy/breaches', {
      title: 'Laptop with wage sheet stolen', description: 'An unencrypted laptop holding the labour wage sheet was stolen.',
      discoveredAt, dataCategories: ['Name', 'Bank account'], principalCategories: ['Labour'], affectedCount: 40,
    });
    expect(res.status).toBe(201);
    breach = res.body.data;
    expect(new Date(breach.boardReportDueAt).getTime() - new Date(discoveredAt).getTime()).toBe(72 * 3600 * 1000);
    expect(breach.hoursToBoardReport).toBe(70);
  });

  it('cannot be closed until the Board and the people affected are told', async () => {
    const early = await T.owner.post(`/api/v1/privacy/breaches/${breach.id}/close`);
    expect(early.status).toBe(400);
    expect(early.body.message).toMatch(/Board/);
    for (const step of ['CONTAINED', 'BOARD_INTIMATED', 'BOARD_REPORT_SUBMITTED', 'PRINCIPALS_NOTIFIED']) {
      expect((await T.owner.post(`/api/v1/privacy/breaches/${breach.id}/steps`, { step, method: 'SMS' })).status).toBe(200);
    }
    const closed = await T.owner.post(`/api/v1/privacy/breaches/${breach.id}/close`);
    expect(closed.body.data.status).toBe('CLOSED');
  });

  it('drafts the Board report and the notice to the people affected', async () => {
    const res = await T.owner.get(`/api/v1/privacy/breaches/${breach.id}/report`);
    expect(res.body.data.boardReport).toMatch(/laptop/i);
    expect(res.body.data.principalNotice).toMatch(/privacy@platform\.test/);
  });

  it("alerts the owner, personally, the night a report is nearly due — not the organisations' staff", async () => {
    await T.owner.post('/api/v1/privacy/breaches', {
      title: 'Misdirected email', description: 'Attendance sheet sent to the wrong address.',
      discoveredAt: new Date(Date.now() - 60 * 60 * 60 * 1000).toISOString(),
    });
    const report = await runPrivacyDuties();
    expect(report.breachReportsDue).toBe(1);
    expect(report.owners).toBe(1);
    const alerts = await Notification.unscoped().findAll({ where: { type: 'PRIVACY_BREACH_REPORT_DUE' } });
    expect(alerts).toHaveLength(1);
    expect(alerts[0].userId).toBe(T.ownerUser.id);
    expect(alerts[0].tenantId).toBe(T.platformId);
  });
});

describe('Retention (s.8(7), Rule 8)', () => {
  it('lists one schedule for the platform, all switched off to begin with', async () => {
    const res = await T.owner.get('/api/v1/privacy/retention');
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThanOrEqual(6);
    expect(res.body.data.every((r) => r.enabled === false)).toBe(true);
  });

  it('will not keep logs for less than a year', async () => {
    const rule = await RetentionRule.findOne({ where: { category: 'AUDIT_LOG_SNAPSHOTS' } });
    expect((await T.owner.put(`/api/v1/privacy/retention/${rule.id}`, { retentionDays: 100 })).status).toBe(400);
  });

  it('does nothing until switched on, then erases what is past its period in every organisation', async () => {
    const old = await Lead.create({
      tenantId: T.tenantId, leadNumber: 'LD/OLD/1', name: 'Old Lost Lead', contactName: 'Gone Person', phone: '9222222222', status: 'LOST',
    });
    await sequelize.query(`UPDATE leads SET "updatedAt" = now() - interval '400 days' WHERE id = :id`, { replacements: { id: old.id } });

    const rule = await RetentionRule.findOne({ where: { category: 'LOST_LEADS' } });
    expect((await T.owner.post(`/api/v1/privacy/retention/${rule.id}/run`)).status).toBe(400);

    await T.owner.put(`/api/v1/privacy/retention/${rule.id}`, { enabled: true, retentionDays: 365 });
    const run = await T.owner.post(`/api/v1/privacy/retention/${rule.id}/run`);
    expect(run.status).toBe(200);
    expect(run.body.data.erased).toBe(1);
    const after = await Lead.findOne({ where: { id: old.id, tenantId: T.tenantId } });
    expect(after.phone).toBeNull();
    expect(after.erasedAt).not.toBeNull();
    expect(await AuditLog.count({ where: { tenantId: T.tenantId, entityId: old.id, action: 'ERASE' } })).toBe(1);

    // The nightly run finds nothing more: an erased record no longer matches.
    const nightly = await runPrivacyDuties();
    expect(nightly.retention.find((r) => r.category === 'LOST_LEADS').erased).toBe(0);
  });
});

describe('The compliance overview', () => {
  it('reports each obligation from the records, across organisations', async () => {
    const res = await T.owner.get('/api/v1/privacy/overview');
    const byKey = Object.fromEntries(res.body.data.checks.map((c) => [c.key, c]));
    expect(byKey.contact.ok).toBe(true);
    expect(byKey.notice.ok).toBe(true);
    expect(byKey.retention.ok).toBe(true);
    expect(byKey.children.ok).toBe(true); // the minor now has a guardian's consent
  });

  it('keeps consent records as evidence after the person is erased', async () => {
    const rows = await ConsentRecord.findAll({ where: { tenantId: T.tenantId, principalId: T.lead.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].principalContact).toBeNull();
    expect(rows[0].status).toBe('WITHDRAWN');
  });
});
