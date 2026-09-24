const request = require('supertest');
const bcrypt = require('bcryptjs');
const ExcelJS = require('exceljs');
const { app } = require('../src/app');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const {
  Tenant, User, Organization, Uom, Product, HsnCode, ProductCategory, Party, AdGroup, AdGroupMember, AuditLog,
} = require('../src/models/index');
const { MasterImportRun } = require('../src/api/masterData/importRun.model');
const { ProductsService } = require('../src/api/products/products.service');
const { Account } = require('../src/api/ledger/account.model');
const { SystemAccounts } = require('../src/api/ledger/systemAccounts');
const { CONFIGS, assertWellFormed } = require('../src/api/masterData/registry');
const { PriceList } = require('../src/api/pricing/priceList.model');
const { PriceListItem } = require('../src/api/pricing/priceListItem.model');
const { Vehicle } = require('../src/api/vehicles/vehicle.model');
const { LeaveType } = require('../src/api/hr/hr.model');

/**
 * Master data by spreadsheet: sample, export, upload, check, commit.
 *
 * The cases that matter are the ones where a bulk tool could quietly do damage
 * a dialog never could — a second upload duplicating everything, a file that
 * half-imports, a clerk setting prices they are not allowed to see, a column
 * the user filled in that the importer silently ignores. Each of those has a
 * test here, and the happy path is almost the least of it.
 */

const PASSWORD = 'password123';
const XLSX = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

let tenantId;
let admin;
let clerk;
let exporter;
let uom;
let hsn;

/** Builds an .xlsx buffer from a header row and plain arrays. */
const workbook = async (headers, rows, { sheetName = 'Data' } = {}) => {
  const wb = new ExcelJS.Workbook();
  const sheet = wb.addWorksheet(sheetName);
  sheet.addRow(headers);
  rows.forEach((row) => sheet.addRow(row));
  return Buffer.from(await wb.xlsx.writeBuffer());
};

/** supertest hands back JSON unless told the body is bytes. */
const binaryParser = (res, callback) => {
  const chunks = [];
  res.on('data', (chunk) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
};

const download = (agent, url, query) => agent.get(url, query).buffer().parse(binaryParser);

const readSheet = async (buffer) => {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const sheet = wb.getWorksheet('Data');
  const rows = [];
  sheet.eachRow((row) => rows.push(row.values.slice(1).map((cell) => (cell === undefined ? null : cell))));
  return { headers: rows[0], rows: rows.slice(1), sheetNames: wb.worksheets.map((w) => w.name) };
};

const PRODUCT_HEADERS = [
  'ID', 'Product Code', 'Product Name', 'Product Type', 'Unit Code', 'Category Code', 'HSN Code',
  'Selling Price (Rs)', 'Standard Cost (Rs)', 'Reorder Level', 'Minimum Stock', 'Maximum Stock',
  'Curing Days', 'QC Required', 'Is Accessory', 'Default Location', 'Status',
];

/** A products row with the given overrides, positioned by header. */
const productRow = (values) => PRODUCT_HEADERS.map((header) => (header in values ? values[header] : null));

const extractCookie = (res, name) => {
  const cookies = res.headers['set-cookie'] || [];
  const match = cookies.find((c) => c.startsWith(`${name}=`));
  return match ? match.split(';')[0] : null;
};

const login = async (email) => {
  const res = await request(app).post('/api/v1/auth/login').send({ email, password: PASSWORD });
  const cookie = extractCookie(res, 'accessToken');
  return {
    get: (url, query) => request(app).get(url).set('Cookie', cookie).query(query || {}),
    post: (url) => request(app).post(url).set('Cookie', cookie),
    upload: (url, buffer, fileName = 'upload.xlsx', query = {}) =>
      request(app).post(url).set('Cookie', cookie).query(query).attach('file', buffer, fileName),
  };
};

const makeUser = async (email, firstName, permissions) => {
  const user = await User.create(
    { tenantId, email, passwordHash: await bcrypt.hash(PASSWORD, 10), firstName, lastName: 'Tester', role: 'EMPLOYEE' },
    { validate: false }
  );
  const group = await AdGroup.create({ tenantId, name: `${firstName} group`, permissions });
  await AdGroupMember.create({ tenantId, adGroupId: group.id, employeeId: user.id });
  return login(email);
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Import Co', slug: 'import-co', status: 'active' });
  tenantId = tenant.id;
  await Organization.create({ tenantId, name: 'Import Co Pvt Ltd', code: 'IMP' });
  await User.create(
    { tenantId, email: 'admin@import.co', passwordHash: await bcrypt.hash(PASSWORD, 10), firstName: 'Asha', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );

  uom = await Uom.create({ tenantId, name: 'Numbers', code: 'NOS' });
  await Uom.create({ tenantId, name: 'Bags', code: 'BAG' });
  hsn = await HsnCode.create({ tenantId, code: '6810', description: 'Precast', gstRatePercent: 18 });
  await ProductCategory.create({ tenantId, name: 'Pipes', code: 'PIPES' });

  admin = await login('admin@import.co');

  // Reads and imports products, but may not create them and may not see rates.
  clerk = await makeUser('clerk@import.co', 'Chandan', ['PRODUCT_READ', 'PRODUCT_MODIFY', 'PRODUCT_IMPORT']);
  // Reads and exports, nothing else.
  exporter = await makeUser('viewer@import.co', 'Vinita', ['PRODUCT_READ', 'PRODUCT_EXPORT', 'VIEW_RATES']);
});

afterAll(async () => {
  await sequelize.close();
});

describe('The sample workbook', () => {
  it('comes back as a named .xlsx with a Data sheet and an Instructions sheet', async () => {
    const res = await download(admin, '/api/v1/master-data/products/template');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain(XLSX);
    expect(res.headers['content-disposition']).toContain('Products_Sample.xlsx');

    const { headers, rows, sheetNames } = await readSheet(res.body);
    expect(sheetNames).toEqual(['Data', 'Instructions']);
    expect(headers).toEqual(PRODUCT_HEADERS);
    // Worked examples, not an empty grid — the user sees the shape of a real row.
    expect(rows.length).toBe(2);
    expect(rows[0]).toContain('FG-PIPE-600');
  });

  it('matches the importer exactly — the sample uploads without a single complaint', async () => {
    const template = await download(admin, '/api/v1/master-data/products/template');

    const res = await admin.upload('/api/v1/master-data/products/import/validate', template.body, 'sample.xlsx');
    // The second example names category '' and HSN 2523, which does not exist
    // here — what matters is that no *column* or *format* complaint appears.
    const columnErrors = (res.body.data.rows || []).flatMap((row) => row.errors).filter((e) => /column|format|required/i.test(e.message));
    expect(res.status).toBe(200);
    expect(columnErrors).toEqual([]);
  });

  it('leaves rate columns out entirely for a role that may not see rates (BR-27)', async () => {
    const res = await download(clerk, '/api/v1/master-data/products/template');
    const { headers } = await readSheet(res.body);
    expect(headers).not.toContain('Selling Price (Rs)');
    expect(headers).not.toContain('Standard Cost (Rs)');
    expect(headers).toContain('Product Code');
  });
});

describe('Refusing a file before it can do harm', () => {
  const upload = (buffer, name = 'products.xlsx') =>
    admin.upload('/api/v1/master-data/products/import/validate', buffer, name);

  it('rejects anything that is not a .xlsx', async () => {
    const res = await upload(Buffer.from('code,name\nA,B'), 'products.csv');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Only \.xlsx files/);
  });

  it('rejects a file that is not really a workbook', async () => {
    const res = await upload(Buffer.from('this is not a spreadsheet'), 'products.xlsx');
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/could not be opened as an Excel workbook/);
  });

  it('names the column that is missing', async () => {
    const buffer = await workbook(PRODUCT_HEADERS.filter((h) => h !== 'Product Name'), [[]]);
    const res = await upload(buffer);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Missing column: Product Name/);
  });

  it('refuses a column it does not accept rather than dropping what the user typed', async () => {
    const buffer = await workbook([...PRODUCT_HEADERS, 'Supplier Name'], [productRow({ 'Product Code': 'X' })]);
    const res = await upload(buffer);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/does not accept: Supplier Name/);
  });

  it('refuses a repeated column, which would otherwise pick one silently', async () => {
    const buffer = await workbook([...PRODUCT_HEADERS, 'Product Code'], [productRow({ 'Product Code': 'X' })]);
    const res = await upload(buffer);
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Repeated column/);
  });

  it('says so when the file has headings and nothing else', async () => {
    const res = await upload(await workbook(PRODUCT_HEADERS, []));
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/no data rows/);
  });
});

describe('Checking every row', () => {
  it('reports each problem against its own row and column, and imports nothing', async () => {
    const buffer = await workbook(PRODUCT_HEADERS, [
      productRow({ 'Product Code': 'FG-OK-1', 'Product Name': 'Fine', 'Product Type': 'Finished Good', 'Unit Code': 'NOS' }),
      productRow({ 'Product Code': 'FG-BAD-1', 'Product Type': 'Finished Good', 'Unit Code': 'NOS' }),
      productRow({ 'Product Code': 'FG-BAD-2', 'Product Name': 'No such unit', 'Product Type': 'Finished Good', 'Unit Code': 'ZZZ' }),
      productRow({ 'Product Code': 'FG-BAD-3', 'Product Name': 'Bad type', 'Product Type': 'Widget', 'Unit Code': 'NOS' }),
      productRow({ 'Product Code': 'FG-BAD-4', 'Product Name': 'Bad number', 'Product Type': 'Finished Good', 'Unit Code': 'NOS', 'Curing Days': 'twenty' }),
      productRow({ 'Product Code': 'FG-BAD-5', 'Product Name': 'Bad yes/no', 'Product Type': 'Finished Good', 'Unit Code': 'NOS', 'QC Required': 'maybe' }),
    ]);

    const res = await admin.upload('/api/v1/master-data/products/import/validate', buffer);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.totalRows).toBe(6);
    expect(data.errorRows).toBe(5);
    expect(data.newRows).toBe(1);

    const messageFor = (rowNumber) => data.rows.find((r) => r.rowNumber === rowNumber).errors.map((e) => e.message).join(' ');
    expect(messageFor(3)).toMatch(/Product Name is required/);
    expect(messageFor(4)).toMatch(/Unit Code "ZZZ" does not exist in the Units of Measure master/);
    expect(messageFor(5)).toMatch(/Product Type must be one of: Finished Good, Raw Material/);
    expect(messageFor(6)).toMatch(/Curing Days must be a number/);
    expect(messageFor(7)).toMatch(/QC Required must be Yes or No/);

    expect(await Product.count({ where: { code: 'FG-OK-1' } })).toBe(0);
  });

  it('catches a code repeated inside the file, naming the row it clashes with', async () => {
    const row = { 'Product Name': 'Twin', 'Product Type': 'Finished Good', 'Unit Code': 'NOS' };
    const buffer = await workbook(PRODUCT_HEADERS, [
      productRow({ ...row, 'Product Code': 'FG-TWIN' }),
      productRow({ ...row, 'Product Code': 'FG-TWIN' }),
    ]);
    const res = await admin.upload('/api/v1/master-data/products/import/validate', buffer);
    expect(res.body.data.errorRows).toBe(1);
    const repeat = res.body.data.rows.find((row) => row.status === 'ERROR');
    expect(repeat.rowNumber).toBe(3);
    expect(repeat.errors[0].message).toMatch(/Repeats Product Code "FG-TWIN" from row 2/);
  });

  it('refuses a length no database column could hold', async () => {
    const buffer = await workbook(PRODUCT_HEADERS, [
      productRow({ 'Product Code': 'X'.repeat(60), 'Product Name': 'Too long', 'Product Type': 'Finished Good', 'Unit Code': 'NOS' }),
    ]);
    const res = await admin.upload('/api/v1/master-data/products/import/validate', buffer);
    expect(res.body.data.rows[0].errors[0].message).toMatch(/longer than 50 characters/);
  });
});

describe('New, changed, unchanged', () => {
  let importId;

  it('creates what is new and says exactly what it will do first', async () => {
    const buffer = await workbook(PRODUCT_HEADERS, [
      productRow({ 'Product Code': 'FG-PIPE-600', 'Product Name': 'RCC Pipe 600mm', 'Product Type': 'Finished Good', 'Unit Code': 'NOS', 'HSN Code': '6810', 'Category Code': 'PIPES', 'Selling Price (Rs)': 4500, 'Curing Days': 28, 'QC Required': 'Yes', Status: 'Active' }),
      productRow({ 'Product Code': 'FG-PIPE-900', 'Product Name': 'RCC Pipe 900mm', 'Product Type': 'Finished Good', 'Unit Code': 'NOS', 'Selling Price (Rs)': 7800 }),
    ]);

    const checked = await admin.upload('/api/v1/master-data/products/import/validate', buffer);
    expect(checked.body.data).toMatchObject({ totalRows: 2, newRows: 2, updateRows: 0, errorRows: 0 });
    importId = checked.body.data.importId;

    const committed = await admin.post(`/api/v1/master-data/imports/${importId}/commit`);
    expect(committed.status).toBe(200);
    expect(committed.body.data).toMatchObject({ createdCount: 2, updatedCount: 0, status: 'COMMITTED' });

    const pipe = await Product.findOne({ where: { code: 'FG-PIPE-600' } });
    // Rupees in the sheet, paise in the database (BR-17).
    expect(Number(pipe.sellingPricePaise)).toBe(450000);
    expect(pipe.uomId).toBe(uom.id);
    expect(pipe.hsnId).toBe(hsn.id);
    expect(pipe.curingDays).toBe(28);
    expect(pipe.qcRequired).toBe(true);
  });

  it('will not commit the same file twice', async () => {
    const res = await admin.post(`/api/v1/master-data/imports/${importId}/commit`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/already been imported/);
  });

  it('updates an existing product and shows the before and after', async () => {
    const buffer = await workbook(PRODUCT_HEADERS, [
      productRow({ 'Product Code': 'FG-PIPE-600', 'Product Name': 'RCC Pipe 600mm NP2', 'Product Type': 'Finished Good', 'Unit Code': 'NOS', 'Selling Price (Rs)': 4800 }),
    ]);
    const checked = await admin.upload('/api/v1/master-data/products/import/validate', buffer);
    expect(checked.body.data).toMatchObject({ newRows: 0, updateRows: 1 });
    expect(checked.body.data.rows[0].changes['Selling Price (Rs)']).toEqual({ from: '450000', to: 480000 });

    await admin.post(`/api/v1/master-data/imports/${checked.body.data.importId}/commit`);
    const pipe = await Product.findOne({ where: { code: 'FG-PIPE-600' } });
    expect(pipe.name).toBe('RCC Pipe 600mm NP2');
    expect(Number(pipe.sellingPricePaise)).toBe(480000);
  });

  it('does nothing at all when the file matches what is already stored', async () => {
    const exported = await download(admin, '/api/v1/master-data/products/export');

    const checked = await admin.upload('/api/v1/master-data/products/import/validate', exported.body, 'round-trip.xlsx');
    expect(checked.body.data.errorRows).toBe(0);
    expect(checked.body.data.newRows).toBe(0);
    expect(checked.body.data.updateRows).toBe(0);
    expect(checked.body.data.unchangedRows).toBeGreaterThan(0);

    const committed = await admin.post(`/api/v1/master-data/imports/${checked.body.data.importId}/commit`);
    expect(committed.body.data).toMatchObject({ createdCount: 0, updatedCount: 0 });
  });
});

describe('Import modes', () => {
  const row = (code) => productRow({ 'Product Code': code, 'Product Name': `Mode ${code}`, 'Product Type': 'Finished Good', 'Unit Code': 'NOS' });

  it('create-only refuses a code that already exists', async () => {
    const buffer = await workbook(PRODUCT_HEADERS, [row('FG-PIPE-600')]);
    const res = await admin.upload('/api/v1/master-data/products/import/validate', buffer, 'x.xlsx', { importMode: 'CREATE' });
    expect(res.body.data.errorRows).toBe(1);
    expect(res.body.data.rows[0].errors[0].message).toMatch(/Create new only/);
  });

  it('update-only refuses a code that does not exist yet', async () => {
    const buffer = await workbook(PRODUCT_HEADERS, [row('FG-NOT-THERE')]);
    const res = await admin.upload('/api/v1/master-data/products/import/validate', buffer, 'x.xlsx', { importMode: 'UPDATE' });
    expect(res.body.data.errorRows).toBe(1);
    expect(res.body.data.rows[0].errors[0].message).toMatch(/Update existing only/);
  });
});

describe('Nothing, or everything', () => {
  it('rolls the whole file back when the business service refuses one row', async () => {
    const before = await Product.count();
    const buffer = await workbook(PRODUCT_HEADERS, [
      productRow({ 'Product Code': 'FG-ATOMIC-A', 'Product Name': 'First', 'Product Type': 'Finished Good', 'Unit Code': 'NOS' }),
      // Max below min: the coercion is fine, so this passes validation and is
      // refused by ProductsService at commit — exactly the case a per-row
      // commit would half-import.
      productRow({ 'Product Code': 'FG-PIPE-600', 'Product Name': 'Second', 'Product Type': 'Finished Good', 'Unit Code': 'NOS', 'Minimum Stock': 100, 'Maximum Stock': 1 }),
    ]);

    const checked = await admin.upload('/api/v1/master-data/products/import/validate', buffer);
    expect(checked.body.data.errorRows).toBe(0);

    const committed = await admin.post(`/api/v1/master-data/imports/${checked.body.data.importId}/commit`);
    expect(committed.status).toBe(400);
    expect(committed.body.message).toMatch(/Nothing was imported/);
    expect(committed.body.message).toMatch(/Maximum stock cannot be lower than minimum stock/);

    expect(await Product.count()).toBe(before);
    expect(await Product.count({ where: { code: 'FG-ATOMIC-A' } })).toBe(0);
    const run = await MasterImportRun.findByPk(checked.body.data.importId);
    expect(run.status).toBe('FAILED');
  });

  it('refuses to commit a file that has failed rows, and hands back an error workbook', async () => {
    const buffer = await workbook(PRODUCT_HEADERS, [
      productRow({ 'Product Code': 'FG-ERR-1', 'Product Type': 'Finished Good', 'Unit Code': 'NOS' }),
    ]);
    const checked = await admin.upload('/api/v1/master-data/products/import/validate', buffer);
    const importId = checked.body.data.importId;

    const committed = await admin.post(`/api/v1/master-data/imports/${importId}/commit`);
    expect(committed.status).toBe(400);
    expect(committed.body.message).toMatch(/1 row with errors/);

    const errors = await download(admin, `/api/v1/master-data/imports/${importId}/errors`);
    expect(errors.status).toBe(200);
    const { headers, rows } = await readSheet(errors.body);
    expect(headers).toContain('Import Status');
    expect(headers).toContain('Error');
    expect(rows[0]).toContain('FG-ERR-1');
    expect(rows[0].join(' ')).toMatch(/Product Name is required/);
  });
});

describe('Export', () => {
  it('writes every matching record, in rupees, with a dated filename', async () => {
    const res = await download(admin, '/api/v1/master-data/products/export', { status: 'active' });

    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/Products_\d{4}-\d{2}-\d{2}\.xlsx/);
    const { headers, rows } = await readSheet(res.body);
    expect(headers).toEqual(PRODUCT_HEADERS);

    const pipe = rows.find((row) => row[1] === 'FG-PIPE-600');
    expect(pipe[4]).toBe('NOS');       // the unit by code, not by id
    expect(pipe[7]).toBe(4800);        // rupees, not paise
    expect(pipe[0]).toMatch(/^[0-9a-f-]{36}$/); // the id, so a round trip matches
  });

  it('honours the filters the screen is showing', async () => {
    await Product.create({ tenantId, uomId: uom.id, name: 'Retired', code: 'FG-RETIRED', productType: 'FINISHED_GOOD', status: 'inactive' });
    const res = await download(admin, '/api/v1/master-data/products/export', { status: 'inactive' });
    const { rows } = await readSheet(res.body);
    expect(rows.map((row) => row[1])).toEqual(['FG-RETIRED']);
  });

  it('neutralises a value that Excel would otherwise run as a formula', async () => {
    await Product.create({ tenantId, uomId: uom.id, name: '=HYPERLINK("http://evil","click")', code: 'FG-FORMULA', productType: 'FINISHED_GOOD' });
    const res = await download(admin, '/api/v1/master-data/products/export', { search: 'FG-FORMULA' });
    const { rows } = await readSheet(res.body);
    const name = rows.find((row) => row[1] === 'FG-FORMULA')[2];
    expect(String(name).startsWith("'=")).toBe(true);
  });
});

describe('Who may do what', () => {
  it('lets a reader download the sample but not the data', async () => {
    const template = await clerk.get('/api/v1/master-data/products/template');
    expect(template.status).toBe(200);
    const exported = await clerk.get('/api/v1/master-data/products/export');
    expect(exported.status).toBe(403);
  });

  it('refuses an import from someone who only holds export', async () => {
    const buffer = await workbook(PRODUCT_HEADERS, [
      productRow({ 'Product Code': 'FG-NOPE', 'Product Name': 'Nope', 'Product Type': 'Finished Good', 'Unit Code': 'NOS' }),
    ]);
    const res = await exporter.upload('/api/v1/master-data/products/import/validate', buffer);
    expect(res.status).toBe(403);
  });

  it('will not let the import grant create records the role may not create by hand', async () => {
    const buffer = await workbook(
      PRODUCT_HEADERS.filter((h) => !h.includes('(Rs)')),
      [PRODUCT_HEADERS.filter((h) => !h.includes('(Rs)')).map((header) => ({
        'Product Code': 'FG-CLERK-NEW', 'Product Name': 'Clerk made this', 'Product Type': 'Finished Good', 'Unit Code': 'NOS',
      }[header] ?? null))]
    );
    const res = await clerk.upload('/api/v1/master-data/products/import/validate', buffer);
    expect(res.status).toBe(403);
    expect(res.body.message).toMatch(/may not create/);
    expect(await Product.count({ where: { code: 'FG-CLERK-NEW' } })).toBe(0);
  });

  it('ignores rate cells from a role that may not see rates, and says so', async () => {
    const headers = PRODUCT_HEADERS.filter((h) => !h.includes('(Rs)'));
    const buffer = await workbook(headers, [
      headers.map((header) => ({
        'Product Code': 'FG-PIPE-600', 'Product Name': 'RCC Pipe 600mm NP2', 'Product Type': 'Finished Good', 'Unit Code': 'NOS',
        'Default Location': 'Yard B',
      }[header] ?? null)),
    ]);

    const checked = await clerk.upload('/api/v1/master-data/products/import/validate', buffer);
    expect(checked.status).toBe(200);
    expect(checked.body.data.warnings.join(' ')).toMatch(/Rate columns .* are ignored/);
    await clerk.post(`/api/v1/master-data/imports/${checked.body.data.importId}/commit`);

    const pipe = await Product.findOne({ where: { code: 'FG-PIPE-600' } });
    expect(pipe.defaultLocation).toBe('Yard B');
    // Untouched, not zeroed — the clerk never saw it and never set it.
    expect(Number(pipe.sellingPricePaise)).toBe(480000);
  });

  it('refuses the price list import outright to a role that may not see rates', async () => {
    const res = await clerk.get('/api/v1/master-data/price-list-items/template');
    expect(res.status).toBe(403);
  });
});

describe('What was imported, and by whom', () => {
  it('keeps a run record with the file name, the counts and the user', async () => {
    const res = await admin.get('/api/v1/master-data/imports', { module: 'products' });
    expect(res.status).toBe(200);
    const committed = res.body.data.rows.find((run) => run.status === 'COMMITTED');
    expect(committed).toMatchObject({ module: 'products', importMode: 'UPSERT' });
    expect(committed.fileName).toBeTruthy();
    expect(committed.userId).toBeTruthy();
    expect(committed.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('writes the ordinary audit trail for every record it touched (BR-30)', async () => {
    const pipe = await Product.findOne({ where: { code: 'FG-PIPE-900' } });
    const created = await AuditLog.findOne({ where: { entityType: 'Product', entityId: pipe.id, action: 'CREATE' } });
    expect(created).toBeTruthy();
    expect(created.afterSnapshot.code).toBe('FG-PIPE-900');
  });
});

describe('The other masters', () => {
  it('imports parties, and refuses to reclassify one on a second upload', async () => {
    const headers = [
      'ID', 'Party Code', 'Party Type', 'Name', 'Legal Name', 'GSTIN', 'PAN', 'Phone', 'Email', 'Address',
      'City', 'State', 'Pincode', 'Payment Terms', 'Credit Period Days', 'Credit Limit (Rs)', 'Credit Ageing Days',
      'Bank Account Number', 'Bank IFSC', 'Bank Name', 'Status',
    ];
    const row = (values) => headers.map((header) => (header in values ? values[header] : null));

    const first = await workbook(headers, [
      row({ 'Party Code': 'CUST-0001', 'Party Type': 'Customer', Name: 'Sradhasis Constructions', State: 'Odisha', 'Credit Limit (Rs)': 500000 }),
    ]);
    const checked = await admin.upload('/api/v1/master-data/parties/import/validate', first);
    expect(checked.body.data.errorRows).toBe(0);
    await admin.post(`/api/v1/master-data/imports/${checked.body.data.importId}/commit`);

    const party = await Party.findOne({ where: { code: 'CUST-0001' } });
    expect(party.partyType).toBe('CUSTOMER');
    expect(Number(party.creditLimitPaise)).toBe(50000000);

    const second = await workbook(headers, [
      row({ 'Party Code': 'CUST-0001', 'Party Type': 'Vendor', Name: 'Sradhasis Constructions', State: 'Odisha' }),
    ]);
    const reclassify = await admin.upload('/api/v1/master-data/parties/import/validate', second);
    expect(reclassify.body.data.errorRows).toBe(1);
    expect(reclassify.body.data.rows[0].errors[0].message).toMatch(/party type cannot be changed by import/);
  });

  it('rejects a GSTIN that would be thrown out by the GST portal', async () => {
    const headers = [
      'ID', 'Party Code', 'Party Type', 'Name', 'Legal Name', 'GSTIN', 'PAN', 'Phone', 'Email', 'Address',
      'City', 'State', 'Pincode', 'Payment Terms', 'Credit Period Days', 'Credit Limit (Rs)', 'Credit Ageing Days',
      'Bank Account Number', 'Bank IFSC', 'Bank Name', 'Status',
    ];
    const buffer = await workbook(headers, [
      headers.map((header) => ({ 'Party Code': 'CUST-BAD', 'Party Type': 'Customer', Name: 'Bad GST', GSTIN: '21ABCDE' }[header] ?? null)),
    ]);
    const res = await admin.upload('/api/v1/master-data/parties/import/validate', buffer);
    expect(res.body.data.rows[0].errors[0].message).toMatch(/GSTIN must be 15 characters/);
  });

  it('leaves system accounts alone rather than failing on them', async () => {
    // System accounts are materialised on first use, so give the chart
    // something to hold: one built-in and one ordinary account.
    const sales = SystemAccounts.CASH;
    await Account.create({ tenantId, code: sales.code, name: sales.name, type: sales.type, accountGroup: sales.group, subType: sales.subType || null });
    const made = await admin.post('/api/v1/ledger/accounts').send({
      code: '5310', name: 'Diesel & Fuel', accountGroup: 'INDIRECT_EXPENSE',
    });
    expect(made.status).toBe(201);

    const exported = await download(admin, '/api/v1/master-data/accounts/export');
    const checked = await admin.upload('/api/v1/master-data/accounts/import/validate', exported.body, 'accounts.xlsx');
    expect(checked.body.data.errorRows).toBe(0);
    expect(checked.body.data.skippedRows).toBeGreaterThan(0);
    expect(checked.body.data.rows.find((row) => row.status === 'SKIP').note).toMatch(/built-in system account/);
  });

  it('refuses a config wired to a service that does not exist', () => {
    // The mistake that got past the first review: VehiclesService for
    // VehicleService. The module looked fine until somebody pressed Import.
    expect(() => assertWellFormed({
      key: 'shifts', label: 'Shifts', fileBase: 'Shifts', resource: 'SHIFT',
      businessKey: 'code', businessKeyHeader: 'Shift Code',
      columns: [{ header: 'Shift Code', field: 'code', type: 'code' }],
      examples: [{}, {}],
      load: async () => [],
      create: undefined, update: undefined,
    })).toThrow(/needs either create and update, or commitAll/);
  });

  it('lists every module the framework covers', async () => {
    const res = await admin.get('/api/v1/master-data/modules');
    expect(res.status).toBe(200);
    expect(res.body.data.map((m) => m.key)).toEqual([
      'uoms', 'hsn-codes', 'product-categories', 'products', 'parties', 'vehicles',
      'price-list-items', 'offices', 'departments', 'accounts', 'leave-types',
    ]);
    expect(res.body.data.find((m) => m.key === 'products').permissions).toMatchObject({
      import: 'PRODUCT_IMPORT', export: 'PRODUCT_EXPORT',
    });
  });
});

describe('Rates, one price list at a time', () => {
  /**
   * The rate card is the import a cement business actually asks for, and the
   * one whose rows are children rather than records. PricingService replaces a
   * list item set wholesale, so the config merges into what is already there —
   * a file holding three revised rates must not delete the other three hundred.
   */
  let listId;
  let pipe;
  let gasket;

  const HEADERS = ['ID', 'Product Code', 'Product Name', 'Rate (Rs)', 'Minimum Quantity', 'Discount %', 'Effective From'];
  const row = (values) => HEADERS.map((header) => (header in values ? values[header] : null));

  beforeAll(async () => {
    const list = await PriceList.create({ tenantId, name: 'Retail 2026-27', priceType: 'RETAIL', status: 'active' });
    listId = list.id;
    pipe = await Product.findOne({ where: { code: 'FG-PIPE-600' } });
    gasket = await Product.create({ tenantId, uomId: uom.id, name: 'EPDM Gasket', code: 'FG-GASKET', productType: 'FINISHED_GOOD' });
    await PriceListItem.create({ tenantId, priceListId: listId, productId: gasket.id, ratePaise: 45000 });
  });

  it('refuses to work without being told which price list', async () => {
    const res = await download(admin, '/api/v1/master-data/price-list-items/export');
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body.toString()).message).toMatch(/Choose a price list first/);
  });

  it('adds a new rate and leaves the rates the file does not mention alone', async () => {
    const buffer = await workbook(HEADERS, [row({ 'Product Code': 'FG-PIPE-600', 'Rate (Rs)': 5200, 'Minimum Quantity': 10 })]);
    const checked = await admin.upload(
      '/api/v1/master-data/price-list-items/import/validate', buffer, 'rates.xlsx', { priceListId: listId }
    );
    expect(checked.body.data).toMatchObject({ errorRows: 0, newRows: 1, updateRows: 0 });

    const committed = await admin.post(`/api/v1/master-data/imports/${checked.body.data.importId}/commit`);
    expect(committed.status).toBe(200);
    expect(committed.body.data).toMatchObject({ createdCount: 1, updatedCount: 0 });

    const items = await PriceListItem.findAll({ where: { priceListId: listId } });
    expect(items).toHaveLength(2);
    const added = items.find((item) => item.productId === pipe.id);
    expect(Number(added.ratePaise)).toBe(520000);
    expect(Number(added.minQuantity)).toBe(10);
    // The rate that was already there and was not in the file.
    expect(Number(items.find((item) => item.productId === gasket.id).ratePaise)).toBe(45000);
  });

  it('revises a rate that is already in the list', async () => {
    const buffer = await workbook(HEADERS, [row({ 'Product Code': 'FG-PIPE-600', 'Rate (Rs)': 5500 })]);
    const checked = await admin.upload(
      '/api/v1/master-data/price-list-items/import/validate', buffer, 'rates.xlsx', { priceListId: listId }
    );
    expect(checked.body.data).toMatchObject({ newRows: 0, updateRows: 1 });
    await admin.post(`/api/v1/master-data/imports/${checked.body.data.importId}/commit`);

    const item = await PriceListItem.findOne({ where: { priceListId: listId, productId: pipe.id } });
    expect(Number(item.ratePaise)).toBe(550000);
    expect(await PriceListItem.count({ where: { priceListId: listId } })).toBe(2);
  });

  it('refuses a product that is not in the catalogue', async () => {
    const buffer = await workbook(HEADERS, [row({ 'Product Code': 'FG-IMAGINARY', 'Rate (Rs)': 100 })]);
    const res = await admin.upload(
      '/api/v1/master-data/price-list-items/import/validate', buffer, 'rates.xlsx', { priceListId: listId }
    );
    expect(res.body.data.rows[0].errors[0].message).toMatch(/Product Code "FG-IMAGINARY" does not exist in the Products master/);
  });
});

describe('The remaining masters write through their own services', () => {
  it('creates a vehicle, and enforces the hired-vehicle rule the screen enforces', async () => {
    const headers = [
      'ID', 'Registration Number', 'Vehicle Type', 'Ownership', 'Transporter Code', 'Capacity (Tonnes)',
      'Tare Weight (Tonnes)', 'Gross Weight (Tonnes)', 'Body Configuration', 'Driver Name', 'Driver Phone',
      'Driver Licence Number', 'Insurance Expiry', 'Fitness Expiry', 'Permit Expiry', 'PUCC Expiry',
      'FASTag Number', 'GPS Device ID', 'Notes', 'Status',
    ];
    const row = (values) => headers.map((header) => (header in values ? values[header] : null));

    const good = await workbook(headers, [
      row({ 'Registration Number': 'od02ab1234', 'Vehicle Type': 'Truck', Ownership: 'Owned', 'Capacity (Tonnes)': 16, 'Insurance Expiry': '31/03/2027' }),
    ]);
    const checked = await admin.upload('/api/v1/master-data/vehicles/import/validate', good);
    expect(checked.body.data.errorRows).toBe(0);
    await admin.post(`/api/v1/master-data/imports/${checked.body.data.importId}/commit`);

    const vehicle = await Vehicle.findOne({ where: { registrationNumber: 'OD02AB1234' } });
    expect(vehicle).toBeTruthy();
    expect(String(vehicle.insuranceExpiry)).toBe('2027-03-31');

    // Hired with no transporter: the service refuses it, so the file does.
    const bad = await workbook(headers, [row({ 'Registration Number': 'OD09XY9999', 'Vehicle Type': 'Tipper', Ownership: 'Hired' })]);
    const second = await admin.upload('/api/v1/master-data/vehicles/import/validate', bad);
    const committed = await admin.post(`/api/v1/master-data/imports/${second.body.data.importId}/commit`);
    expect(committed.status).toBe(400);
    expect(committed.body.message).toMatch(/hired vehicle needs the transporter/);
    expect(await Vehicle.count({ where: { registrationNumber: 'OD09XY9999' } })).toBe(0);
  });

  it('creates leave types, including one that is born inactive', async () => {
    const headers = ['ID', 'Leave Code', 'Leave Name', 'Days Per Year', 'Paid', 'Description', 'Status'];
    const row = (values) => headers.map((header) => (header in values ? values[header] : null));

    const buffer = await workbook(headers, [
      row({ 'Leave Code': 'CL', 'Leave Name': 'Casual Leave', 'Days Per Year': 12, Paid: 'Yes', Status: 'Active' }),
      row({ 'Leave Code': 'SAB', 'Leave Name': 'Sabbatical', 'Days Per Year': 0, Paid: 'No', Status: 'Inactive' }),
    ]);
    const checked = await admin.upload('/api/v1/master-data/leave-types/import/validate', buffer);
    expect(checked.body.data).toMatchObject({ errorRows: 0, newRows: 2 });
    const committed = await admin.post(`/api/v1/master-data/imports/${checked.body.data.importId}/commit`);
    expect(committed.body.data.createdCount).toBe(2);

    const casual = await LeaveType.findOne({ where: { code: 'CL' } });
    expect(Number(casual.daysPerYear)).toBe(12);
    expect(casual.isPaid).toBe(true);
    // createLeaveType takes no isActive, so the config deactivates in a second
    // step. That it landed matters more than how.
    const sabbatical = await LeaveType.findOne({ where: { code: 'SAB' } });
    expect(sabbatical.isActive).toBe(false);
  });
});

describe('The fast path does not cost a rule', () => {
  /**
   * The commit tells the master services that the keys and references in this
   * file have already been checked, which is what takes a created product from
   * six database round trips to two. Everything below is the proof that the
   * shortcut is only a shortcut: the screens still get every check, and the
   * importer still refuses what the checks would have refused.
   */

  it('still enforces every check for an ordinary caller, which is what the screens are', async () => {
    const uomId = uom.id;
    // No options argument: exactly how the New Product dialog calls it.
    await expect(
      ProductsService.createProduct({ code: 'FG-PIPE-600', name: 'Duplicate', productType: 'FINISHED_GOOD', uomId })
    ).rejects.toThrow(/already exists/);

    await expect(
      ProductsService.createProduct({
        code: 'FG-BAD-REF', name: 'Bad reference', productType: 'FINISHED_GOOD',
        uomId: '00000000-0000-0000-0000-000000000000',
      })
    ).rejects.toThrow(/unit of measure does not exist/);
  });

  it('refuses a file that moves an existing code onto a different record', async () => {
    // Matched by ID, so the code was never looked up — and without this check
    // the import would hand two products the same code.
    const existing = await Product.findOne({ where: { code: 'FG-PIPE-900' } });
    const buffer = await workbook(PRODUCT_HEADERS, [
      productRow({
        ID: existing.id, 'Product Code': 'FG-PIPE-600', 'Product Name': 'Stealing a code',
        'Product Type': 'Finished Good', 'Unit Code': 'NOS',
      }),
    ]);

    const res = await admin.upload('/api/v1/master-data/products/import/validate', buffer);
    expect(res.body.data.errorRows).toBe(1);
    expect(res.body.data.rows[0].errors[0].message).toMatch(/already belongs to another record/);
    // And the product it tried to rename is untouched.
    expect((await Product.findByPk(existing.id)).code).toBe('FG-PIPE-900');
  });

  it('still refuses a reference that does not exist, before anything is written', async () => {
    const buffer = await workbook(PRODUCT_HEADERS, [
      productRow({ 'Product Code': 'FG-NOREF', 'Product Name': 'No such unit', 'Product Type': 'Finished Good', 'Unit Code': 'ZZZ' }),
    ]);
    const res = await admin.upload('/api/v1/master-data/products/import/validate', buffer);
    expect(res.body.data.errorRows).toBe(1);
    expect(await Product.count({ where: { code: 'FG-NOREF' } })).toBe(0);
  });

  it('tells the user how long the commit will take before starting it', async () => {
    const rows = Array.from({ length: 25 }, (unused, index) =>
      productRow({
        'Product Code': `FG-EST-${index}`, 'Product Name': `Estimate ${index}`,
        'Product Type': 'Finished Good', 'Unit Code': 'NOS',
      })
    );
    const res = await admin.upload('/api/v1/master-data/products/import/validate', await workbook(PRODUCT_HEADERS, rows));
    expect(res.body.data.newRows).toBe(25);
    expect(res.body.data.estimatedCommitSeconds).toBeGreaterThan(0);
    expect(res.body.data.databaseRoundTripMs).toBeGreaterThanOrEqual(0);
  });

  it('promises nothing when there is nothing to write', async () => {
    const exported = await download(admin, '/api/v1/master-data/products/export');
    const res = await admin.upload('/api/v1/master-data/products/import/validate', exported.body, 'again.xlsx');
    expect(res.body.data.newRows + res.body.data.updateRows).toBe(0);
    expect(res.body.data.estimatedCommitSeconds).toBe(0);
  });
});

describe('Every module in the registry', () => {
  /**
   * The cheap check that catches the expensive mistake.
   *
   * A config whose `load` names an association the model does not have throws
   * only when something asks it for real data — and the Departments export did
   * exactly that ("Organization is not associated to Department"), which no
   * per-master unit test noticed because it exercised an empty table. Walking
   * the registry and asking each module for a sample and an export closes that
   * for every master, including ones added later.
   */
  let priceListId;

  beforeAll(async () => {
    const list = await PriceList.create({ tenantId, name: 'Standard Rates', priceType: 'RETAIL', status: 'active' });
    priceListId = list.id;
  });

  it.each(CONFIGS.map((config) => [config.key, config.label]))(
    '%s hands back a sample and an export whose columns agree',
    async (key) => {
      const config = CONFIGS.find((c) => c.key === key);
      const query = config.context ? { [config.context.param]: priceListId } : {};

      const template = await download(admin, `/api/v1/master-data/${key}/template`, query);
      expect(template.status).toBe(200);
      const sample = await readSheet(template.body);
      expect(sample.sheetNames).toEqual(['Data', 'Instructions']);
      expect(sample.rows.length).toBe(2);

      const exported = await download(admin, `/api/v1/master-data/${key}/export`, query);
      expect(exported.status).toBe(200);
      const file = await readSheet(exported.body);
      expect(file.sheetNames).toEqual(['Data', 'Instructions']);

      // Every column the sample asks for must come back out of the export, or a
      // downloaded file could not be edited and re-uploaded.
      expect(sample.headers.filter((header) => !file.headers.includes(header))).toEqual([]);
    }
  );
});
