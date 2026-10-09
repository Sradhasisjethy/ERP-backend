/**
 * Regression tests for the second upload / user-input review of 2026-10-09
 * (findings N4, N5, N8 and N12). Each refusal here was an acceptance before
 * the fix — or, for N4, an acceptance after seconds of parsing.
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
const AVATARS = path.join(__dirname, '../uploads/avatars');

const extractCookie = (res, name) => {
  const match = (res.headers['set-cookie'] || []).find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};
const loginAs = async (email) =>
  extractCookie(await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD }), 'accessToken');

const folderOf = (employeeId) => path.join(UPLOADS, employeeId);
const avatarFile = (url) => path.join(AVATARS, path.basename(url));

let T;
let createdAvatars = [];

beforeAll(async () => {
  await resetDatabase();
  const passwordHash = await bcrypt.hash(PASSWORD, 10);
  const tenant = await Tenant.create({ name: 'Inputs Co', slug: 'inputs-co', status: 'active' });
  const rival = await Tenant.create({ name: 'Inputs Rival', slug: 'inputs-rival', status: 'active' });
  const mk = (email, role = 'EMPLOYEE', tenantId = tenant.id) =>
    User.create({ tenantId, email, passwordHash, firstName: 'F', lastName: 'L', role, status: 'ACTIVE' }, { validate: false });

  await mk('admin@inputs.test', 'PLATFORM_ADMIN');
  T = {
    tenantId: tenant.id,
    staff: await mk('staff@inputs.test'),
    a: await mk('a@inputs.test'),
    b: await mk('b@inputs.test'),
    rivalUser: await mk('user@inputs-rival.test', 'EMPLOYEE', rival.id),
  };
  T.admin = await loginAs('admin@inputs.test');
});

afterEach(async () => {
  for (const id of [T.staff.id, T.a.id, T.b.id]) fs.rmSync(folderOf(id), { recursive: true, force: true });
  for (const url of createdAvatars) fs.rmSync(avatarFile(url), { force: true });
  createdAvatars = [];
  await User.unscoped().update({ avatar: null }, { where: { id: [T.a.id, T.b.id, T.rivalUser.id] }, hooks: false });
});

afterAll(async () => {
  await sequelize.close();
});

const PDF = Buffer.from('%PDF-1.4\n%synthetic test document\n');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const DOCX = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const uploadDocument = (buffer, { filename = 'id.pdf', contentType = 'application/pdf', employeeId } = {}) =>
  request(app)
    .post(`/api/v1/users/${employeeId || T.staff.id}/documents`)
    .set('Cookie', T.admin)
    .field('documentType', 'ID')
    .attach('document', buffer, { filename, contentType });

const uploadAvatar = async () => {
  const res = await request(app).post('/api/v1/users/avatar').set('Cookie', T.admin).attach('avatar', PNG, { filename: 'me.png', contentType: 'image/png' });
  expect(res.status).toBe(201);
  createdAvatars.push(res.body.data.url);
  return res.body.data.url;
};
const setAvatar = (userId, avatar) =>
  request(app).put(`/api/v1/users/${userId}`).set('Cookie', T.admin).send({ avatar });

const importProducts = (buffer) =>
  request(app)
    .post('/api/v1/master-data/products/import/validate')
    .set('Cookie', T.admin)
    .attach('file', buffer, 'products.xlsx');

/** A workbook whose only sheet is replaced with `sheetData` rows. */
const workbookWithRows = async (rowXml, count) => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Data').addRow(['Product Code', 'Product Name']);
  const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
  const sheet = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    rowXml.repeat(count)
  }</sheetData></worksheet>`;
  zip.file('xl/worksheets/sheet1.xml', sheet);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
};

describe('N4: an oversized sheet is refused before ExcelJS parses it', () => {
  it('refuses 45 MB of sheet XML (under the 50 MB total) quickly', async () => {
    // 50 cells a row, ~1.3 KB: about 34,500 rows — the shape of the review's probe.
    const cells = Array.from({ length: 50 }, () => '<c><v>1</v></c>').join('');
    const row = `<row>${cells}</row>`;
    const file = await workbookWithRows(row, Math.ceil(45e6 / row.length));
    expect(file.length).toBeLessThan(5 * 1024 * 1024);

    const started = Date.now();
    const res = await importProducts(file);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/sheets in that file unpack to more than 10 MB|more than 5,000 rows/);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('counts rows while inflating, so a small sheet with too many rows is refused too', async () => {
    const file = await workbookWithRows('<row><c t="inlineStr"><is><t>X</t></is></c></row>', 6000);
    const res = await importProducts(file);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/more than 5,000 rows/);
  });
});

describe('N5: an avatar file belongs to the account that uses it', () => {
  it('refuses pointing one account at another account\'s picture, in any tenant', async () => {
    const mine = await uploadAvatar();
    const theirs = await uploadAvatar();
    expect((await setAvatar(T.a.id, theirs)).status).toBe(200);
    expect((await setAvatar(T.b.id, mine)).status).toBe(200);

    const res = await setAvatar(T.b.id, theirs);
    expect(res.status).toBe(400);
    expect(res.body.message).toBe('That picture belongs to another account');
    expect((await User.findByPk(T.b.id)).avatar).toBe(mine);

    // The avatars folder is shared by every tenant, so is the check.
    const rivals = await uploadAvatar();
    await User.unscoped().update({ avatar: rivals }, { where: { id: T.rivalUser.id }, hooks: false });
    expect((await setAvatar(T.b.id, rivals)).status).toBe(400);

    // Saving the picture you already have is not a conflict.
    expect((await setAvatar(T.b.id, mine)).status).toBe(200);
  });

  it('removes a replaced picture nobody uses, and keeps one somebody still does', async () => {
    const shared = await uploadAvatar();
    const own = await uploadAvatar();
    expect((await setAvatar(T.a.id, shared)).status).toBe(200);
    expect((await setAvatar(T.b.id, own)).status).toBe(200);

    // B's own file goes when B clears it.
    expect((await setAvatar(T.b.id, null)).status).toBe(200);
    expect(fs.existsSync(avatarFile(own))).toBe(false);

    // A row saved before the check existed may share A's file. Clearing B's
    // picture must not delete A's.
    await User.unscoped().update({ avatar: shared }, { where: { id: T.b.id }, hooks: false });
    expect((await setAvatar(T.b.id, null)).status).toBe(200);
    expect(fs.existsSync(avatarFile(shared))).toBe(true);
    expect((await User.findByPk(T.a.id)).avatar).toBe(shared);
  });
});

describe('N8: the employee folder is named by the canonical id', () => {
  it('stores an upload to the uppercase id under the lowercase folder, and serves it', async () => {
    const res = await uploadDocument(PDF, { employeeId: T.staff.id.toUpperCase() });
    expect(res.status).toBe(201);
    expect(fs.readdirSync(UPLOADS)).toContain(T.staff.id.toLowerCase());
    expect(fs.readdirSync(UPLOADS)).not.toContain(T.staff.id.toUpperCase());

    const download = await request(app)
      .get(`/api/v1/users/${T.staff.id.toLowerCase()}/documents/${res.body.data.id}/file`)
      .set('Cookie', T.admin);
    expect(download.status).toBe(200);
    await EmployeeDocument.destroy({ where: { id: res.body.data.id } });
  });

  it('refuses an id that is only UUID-shaped, without creating a folder', async () => {
    const before = fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : [];
    const res = await uploadDocument(PDF, { employeeId: '-'.repeat(36) });
    expect(res.status).toBe(400);
    expect(fs.existsSync(UPLOADS) ? fs.readdirSync(UPLOADS) : []).toEqual(before);
  });

  it('leaves no empty folder behind when the employee does not exist', async () => {
    const missing = '0f0e0d0c-0b0a-4908-8706-050403020100';
    const res = await uploadDocument(PDF, { employeeId: missing });
    expect(res.status).toBe(404);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.existsSync(folderOf(missing))).toBe(false);
  });
});

describe('N12: document verification and document contents', () => {
  it('requires a boolean to verify, and reports what was stored', async () => {
    const created = await uploadDocument(PDF);
    expect(created.status).toBe(201);
    const verify = (body) =>
      request(app)
        .patch(`/api/v1/users/${T.staff.id}/documents/${created.body.data.id}/verify`)
        .set('Cookie', T.admin)
        .send(body);

    expect((await verify({})).status).toBe(400);
    expect((await verify({ isVerified: 'true' })).status).toBe(400);
    expect((await verify({ isVerified: true, extra: 1 })).status).toBe(400);

    const on = await verify({ isVerified: true });
    expect(on.status).toBe(200);
    expect(on.body.message).toBe('Document verified successfully');

    const off = await verify({ isVerified: false });
    expect(off.status).toBe(200);
    expect(off.body.message).toMatch(/unverified/);
    expect((await EmployeeDocument.findByPk(created.body.data.id)).isVerified).toBe(false);
    await EmployeeDocument.destroy({ where: { id: created.body.data.id } });
  });

  it('refuses a zip without [Content_Types].xml declared as a Word file', async () => {
    const zip = new JSZip();
    zip.file('word/document.xml', '<w:document/>');
    zip.file('notes.txt', 'just an archive');
    const res = await uploadDocument(await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), {
      filename: 'letter.docx',
      contentType: DOCX,
    });
    expect(res.status).toBe(400);
    expect(fs.existsSync(folderOf(T.staff.id)) ? fs.readdirSync(folderOf(T.staff.id)) : []).toEqual([]);
  });

  it('accepts real Word and Excel files', async () => {
    const docx = new JSZip();
    docx.file('[Content_Types].xml', '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');
    docx.file('word/document.xml', '<w:document/>');
    const word = await uploadDocument(await docx.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }), {
      filename: 'letter.docx',
      contentType: DOCX,
    });
    expect(word.status).toBe(201);

    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet('Sheet1').addRow(['salary', 1]);
    const excel = await uploadDocument(Buffer.from(await workbook.xlsx.writeBuffer()), { filename: 'pay.xlsx', contentType: XLSX });
    expect(excel.status).toBe(201);

    // Excel's own file is not a Word document.
    const mislabelled = await uploadDocument(Buffer.from(await workbook.xlsx.writeBuffer()), { filename: 'pay.docx', contentType: DOCX });
    expect(mislabelled.status).toBe(400);
    await EmployeeDocument.destroy({ where: { id: [word.body.data.id, excel.body.data.id] } });
  });

  it('keeps a Devanagari filename as the display name', async () => {
    const name = 'प्रमाण.pdf'.normalize('NFC');
    const res = await uploadDocument(PDF, { filename: name });
    expect(res.status).toBe(201);
    expect(res.body.data.fileName).toBe(name);
    expect(res.body.data.fileKey).toMatch(/^[\d-]+\.pdf$/);
    await EmployeeDocument.destroy({ where: { id: res.body.data.id } });
  });

  it('still replaces the characters Windows reserves in a filename', async () => {
    const res = await uploadDocument(PDF, { filename: 'a<b>c|d?e*f:g.pdf' });
    expect(res.status).toBe(201);
    expect(res.body.data.fileName).toBe('a_b_c_d_e_f_g.pdf');
    await EmployeeDocument.destroy({ where: { id: res.body.data.id } });
  });
});

describe('N12(d): user fields are bounded', () => {
  it('refuses an over-long name or address, and a non-calendar joining date', async () => {
    const put = (body) => request(app).put(`/api/v1/users/${T.a.id}`).set('Cookie', T.admin).send(body);
    expect((await put({ firstName: 'x'.repeat(256) })).status).toBe(400);
    expect((await put({ address: 'x'.repeat(5001) })).status).toBe(400);
    expect((await put({ pincode: '1'.repeat(21) })).status).toBe(400);
    expect((await put({ dateOfJoining: '2026-02-30' })).status).toBe(400);
    expect((await put({ dateOfJoining: '2026-04-01', resignationDate: null })).status).toBe(200);
  });
});
