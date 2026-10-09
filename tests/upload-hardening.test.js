/**
 * Regression tests for the upload / file review of 2026-10-09 (findings I3, I4,
 * I7, I11 and I12). Each refusal here was an acceptance — or a 500 — before
 * the fix, and each stored file here used to keep the client's own extension.
 */
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { EmployeeDocument } = require('../src/api/users/employeeDocument.model');
const { Tenant, User } = require('../src/models/index');

const PASSWORD = 'password123';
const UPLOADS = path.join(__dirname, '../uploads/employees');

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

const folderOf = (employeeId) => path.join(UPLOADS, employeeId);
const filesIn = (employeeId) => (fs.existsSync(folderOf(employeeId)) ? fs.readdirSync(folderOf(employeeId)) : []);

let T;

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const tenant = await Tenant.create({ name: 'Upload Co', slug: 'upload-co', status: 'active' });
  const mk = (email, role = 'EMPLOYEE') =>
    User.create({ tenantId: tenant.id, email, passwordHash, firstName: 'F', lastName: 'L', role, status: 'ACTIVE' }, { validate: false });

  await mk('admin@upload.test', 'PLATFORM_ADMIN');
  const staff = await mk('staff@upload.test');
  T = { tenantId: tenant.id, staff };
  T.admin = await loginAs('admin@upload.test');
});

afterEach(() => {
  fs.rmSync(folderOf(T.staff.id), { recursive: true, force: true });
});

afterAll(async () => {
  await sequelize.close();
});

const uploadDocument = (buffer, { filename = 'id.pdf', contentType = 'application/pdf', documentType = 'ID', employeeId } = {}) =>
  request(app)
    .post(`/api/v1/users/${employeeId || T.staff.id}/documents`)
    .set('Cookie', T.admin)
    .field('documentType', documentType)
    .attach('document', buffer, { filename, contentType });

const PDF = Buffer.from('%PDF-1.4\n%synthetic test document\n');

describe('I12: a document must be what it says it is', () => {
  it('refuses HTML declared as a PDF, and keeps nothing on disk', async () => {
    const res = await uploadDocument(Buffer.from('<html><script>alert(1)</script></html>'), { filename: 'cv.pdf' });
    expect(res.status).toBe(400);
    expect(filesIn(T.staff.id)).toEqual([]);
    expect(await EmployeeDocument.unscoped().count({ where: { employeeId: T.staff.id } })).toBe(0);
  });

  it('refuses an empty file', async () => {
    const res = await uploadDocument(Buffer.alloc(0));
    expect(res.status).toBe(400);
    expect(filesIn(T.staff.id)).toEqual([]);
  });

  it('stores a real PDF under a .pdf name, whatever the client called it', async () => {
    const res = await uploadDocument(PDF, { filename: 'x.html' });
    expect(res.status).toBe(201);
    expect(res.body.data.fileKey).toMatch(/\.pdf$/);
    expect(filesIn(T.staff.id)).toEqual([res.body.data.fileKey]);
    // The client's name survives only as the display name.
    expect(res.body.data.fileName).toBe('x.html');
  });

  it('refuses an over-long document type without leaving an orphan file', async () => {
    const res = await uploadDocument(PDF, { documentType: 'x'.repeat(300) });
    expect(res.status).toBe(400);
    expect(filesIn(T.staff.id)).toEqual([]);
  });

  it('answers a too-big file with a 400, not a 500', async () => {
    const big = Buffer.concat([PDF, Buffer.alloc(11 * 1024 * 1024, 0x20)]);
    const res = await uploadDocument(big);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/larger than 10 MB/);
    expect(filesIn(T.staff.id)).toEqual([]);
  });

  it('deletes the row and then the file', async () => {
    const created = await uploadDocument(PDF);
    expect(created.status).toBe(201);
    const res = await request(app)
      .delete(`/api/v1/users/${T.staff.id}/documents/${created.body.data.id}`)
      .set('Cookie', T.admin);
    expect(res.status).toBe(200);
    expect(await EmployeeDocument.unscoped().findByPk(created.body.data.id)).toBeNull();
    // The unlink is fire-and-forget after the response; give it a moment.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(filesIn(T.staff.id)).toEqual([]);
  });

  it('answers a missing document with a 404 rather than a 500', async () => {
    const missing = '00000000-0000-4000-8000-000000000000';
    const del = await request(app).delete(`/api/v1/users/${T.staff.id}/documents/${missing}`).set('Cookie', T.admin);
    expect(del.status).toBe(404);
    const verify = await request(app)
      .patch(`/api/v1/users/${T.staff.id}/documents/${missing}/verify`)
      .set('Cookie', T.admin)
      .send({ isVerified: true });
    expect(verify.status).toBe(404);
  });

  it('removes an employee\'s document folder when the employee is deleted', async () => {
    const leaver = await User.create(
      { tenantId: T.tenantId, email: 'leaver@upload.test', passwordHash: 'x', firstName: 'L', lastName: 'L', role: 'EMPLOYEE', status: 'ACTIVE' },
      { validate: false }
    );
    expect((await uploadDocument(PDF, { employeeId: leaver.id })).status).toBe(201);
    expect(filesIn(leaver.id)).toHaveLength(1);

    const res = await request(app).delete(`/api/v1/users/${leaver.id}`).set('Cookie', T.admin);
    expect(res.status).toBe(200);
    expect(fs.existsSync(folderOf(leaver.id))).toBe(false);
  });
});

describe('I3: a legacy document is never served as something a browser runs', () => {
  it('serves a row stored as text/html as an opaque download, uncached', async () => {
    fs.mkdirSync(folderOf(T.staff.id), { recursive: true });
    fs.writeFileSync(path.join(folderOf(T.staff.id), 'legacy.html'), '<script>alert(1)</script>');
    const doc = await EmployeeDocument.create({
      tenantId: T.tenantId,
      employeeId: T.staff.id,
      documentType: 'Old',
      fileName: 'résumé.html',
      fileKey: 'legacy.html',
      fileSize: 25,
      mimeType: 'text/html',
    });

    const res = await request(app).get(`/api/v1/users/${T.staff.id}/documents/${doc.id}/file`).set('Cookie', T.admin);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/^application\/octet-stream/);
    expect(res.headers['cache-control']).toMatch(/no-store/);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    // RFC 6266: an ASCII fallback plus the UTF-8 name.
    expect(res.headers['content-disposition']).toBe(`attachment; filename="r_sum_.html"; filename*=UTF-8''r%C3%A9sum%C3%A9.html`);
    await doc.destroy();
  });
});

describe('I7 / I11: avatars', () => {
  it('refuses an avatar pointing anywhere but our own uploads', async () => {
    const res = await request(app).put(`/api/v1/users/${T.staff.id}`).set('Cookie', T.admin).send({ avatar: 'https://evil.test/p.gif' });
    expect(res.status).toBe(400);
  });

  it('accepts a path the avatar upload issued', async () => {
    const res = await request(app)
      .put(`/api/v1/users/${T.staff.id}`)
      .set('Cookie', T.admin)
      .send({ avatar: '/uploads/avatars/avatar-1-2.png' });
    expect(res.status).toBe(200);
    expect((await User.findByPk(T.staff.id)).avatar).toBe('/uploads/avatars/avatar-1-2.png');
  });

  it('refuses a multipart body padded with extra fields', async () => {
    let req = request(app).post('/api/v1/users/avatar').set('Cookie', T.admin);
    for (let i = 0; i < 50; i += 1) req = req.field(`f${i}`, 'x');
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const res = await req.attach('avatar', png, { filename: 'a.png', contentType: 'image/png' });
    expect(res.status).toBe(400);
  });
});

describe('I4: a workbook that unpacks to far more than it weighs', () => {
  it('is refused before it is inflated', async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Data').addRow(['Product Code', 'Product Name']);
    const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());

    const row = '<row><c t="inlineStr"><is><t>AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA</t></is></c></row>';
    const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
      row.repeat(Math.ceil((60 * 1024 * 1024) / row.length))
    }</sheetData></worksheet>`;
    zip.file('xl/worksheets/sheet1.xml', sheet);
    const bomb = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    expect(bomb.length).toBeLessThan(5 * 1024 * 1024);

    const res = await request(app)
      .post('/api/v1/master-data/products/import/validate')
      .set('Cookie', T.admin)
      .attach('file', bomb, 'products.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/unpacks to more than 50 MB/);
  });
});
