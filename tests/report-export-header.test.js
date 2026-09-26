const ExcelJS = require('exceljs');
const { PassThrough } = require('stream');
const cls = require('cls-hooked');
const { sequelize } = require('../src/config/database');
const { resetDatabase } = require('./helpers/db');
const { Tenant, User, Organization, Factory } = require('../src/models/index');
const { NAMESPACE_NAME } = require('../src/core/tenantContext');
const { resolveOrganizationName } = require('../src/api/reports/export/index');
const { buildXlsx } = require('../src/api/reports/export/xlsx');

/**
 * Whose name goes at the top of an exported report.
 *
 * It used to be whatever organisation the signed-in user was attached to. One
 * login still pointed at an organisation deactivated long ago, so a sales
 * report in which every invoice belonged to Infideep Precast went out headed
 * "Acme Global". A report is a business document and the company named on it
 * has to be the company whose business it describes.
 */

let tenantId;
let userId;
let staleOrgId;
let realOrgId;
let plantId;

const inTenant = (run) => {
  const namespace = cls.getNamespace(NAMESPACE_NAME) || cls.createNamespace(NAMESPACE_NAME);
  return namespace.runPromise(async () => {
    namespace.set('tenantId', tenantId);
    namespace.set('userId', userId);
    return run();
  });
};

beforeAll(async () => {
  await resetDatabase();
  const tenant = await Tenant.create({ name: 'Header Co', slug: 'header-co', status: 'active' });
  tenantId = tenant.id;

  const stale = await Organization.create({ tenantId, name: 'Old Shell Ltd', code: 'OLD', status: 'inactive' });
  const real = await Organization.create({ tenantId, name: 'Real Trading Pvt Ltd', code: 'REAL', status: 'active' });
  staleOrgId = stale.id;
  realOrgId = real.id;

  // The trap: the login belongs to the shell, the plants belong to the business.
  const user = await User.create(
    { tenantId, organizationId: stale.id, email: 'admin@header.co', passwordHash: 'x', firstName: 'Asha', lastName: 'Admin', role: 'PLATFORM_ADMIN' },
    { validate: false }
  );
  userId = user.id;

  const plant = await Factory.create({ tenantId, organizationId: real.id, name: 'Real Plant', code: 'RP', state: 'Odisha' });
  plantId = plant.id;
});

afterAll(async () => {
  await sequelize.close();
});

const req = () => ({ user: { organizationId: staleOrgId, tenantId } });

describe('The company named on an exported report', () => {
  it('is the one that owns the plants, not the one the login is attached to', async () => {
    const name = await inTenant(() => resolveOrganizationName(req(), {}));
    expect(name).toBe('Real Trading Pvt Ltd');
    expect(name).not.toBe('Old Shell Ltd');
  });

  it('is the owner of the plant when the report is filtered to one', async () => {
    const name = await inTenant(() => resolveOrganizationName(req(), { factoryId: plantId }));
    expect(name).toBe('Real Trading Pvt Ltd');
  });

  it('still uses the login when its organisation is the live one', async () => {
    await Organization.update({ status: 'active' }, { where: { id: staleOrgId } });
    await Factory.update({ organizationId: staleOrgId }, { where: { id: plantId } });

    const name = await inTenant(() => resolveOrganizationName(req(), {}));
    expect(name).toBe('Old Shell Ltd');

    await Factory.update({ organizationId: realOrgId }, { where: { id: plantId } });
    await Organization.update({ status: 'inactive' }, { where: { id: staleOrgId } });
  });

  it('falls back to the tenant when nothing else can answer', async () => {
    await Factory.destroy({ where: { id: plantId } });
    const name = await inTenant(() => resolveOrganizationName(req(), {}));
    expect(name).toBe('Header Co');
    await Factory.create({ tenantId, organizationId: realOrgId, id: plantId, name: 'Real Plant', code: 'RP', state: 'Odisha' });
  });
});

describe('How much of the sheet is preamble', () => {
  const definition = { name: 'Sales Summary', description: 'One row per sales invoice.' };
  const columns = [
    { key: 'invoiceNo', header: 'Invoice No', type: 'text', align: 'left' },
    { key: 'gross', header: 'Gross Amount', type: 'money', align: 'right', total: true },
  ];
  const metrics = [
    { key: 'invoices', label: 'Invoices', type: 'int' },
    { key: 'gross', label: 'Gross Sales', type: 'money' },
    { key: 'outstanding', label: 'Outstanding', type: 'money' },
  ];

  /** The writer streams; collect what it streams and open that. */
  const collect = (run) =>
    new Promise((resolve, reject) => {
      const sink = new PassThrough();
      const chunks = [];
      sink.on('data', (chunk) => chunks.push(chunk));
      sink.on('end', () => resolve(Buffer.concat(chunks)));
      sink.on('error', reject);
      run(sink).catch(reject);
    });

  const render = async () => {
    const buffer = await collect((sink) => buildXlsx({
      definition,
      columns,
      rows: [{ invoiceNo: 'INV/0001', gross: 100000 }],
      summary: { invoices: 1, gross: 100000, outstanding: 0 },
      metrics,
      meta: {
        organizationName: 'Real Trading Pvt Ltd',
        periodLabel: 'All dates',
        locationLabel: 'All permitted locations',
        filterLabel: '',
        generatedAt: new Date('2026-09-24T19:20:00Z'),
        userName: 'John Smith',
        canViewRates: true,
      },
      settings: { currency: 'INR', locale: 'en-IN' },
    }, sink));
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    return workbook.worksheets[0];
  };

  const textOf = (sheet, rowNumber) => String(sheet.getRow(rowNumber).getCell(1).value ?? '');

  it('says everything it used to, in three lines instead of eight', async () => {
    const sheet = await render();
    expect(textOf(sheet, 1)).toBe('Real Trading Pvt Ltd');
    expect(textOf(sheet, 2)).toContain('Sales Summary');
    expect(textOf(sheet, 2)).toContain('One row per sales invoice.');

    const context = textOf(sheet, 3);
    for (const fact of ['All dates', 'All permitted locations', 'Amounts in INR', 'John Smith']) {
      expect(context).toContain(fact);
    }
  });

  it('lays the summary figures across rather than one per row', async () => {
    const sheet = await render();
    // Labels on one row, figures beneath: two rows for three metrics, not four.
    expect(sheet.getRow(5).values.slice(1)).toEqual(['Invoices', 'Gross Sales', 'Outstanding']);
    // Numbers, not text — the whole reason this is a workbook rather than a
    // grid of strings is that the reader can re-total and pivot it.
    expect(sheet.getRow(6).values.slice(1)).toEqual([1, 1000, 0]);
    expect(sheet.getRow(6).getCell(2).numFmt).toBeTruthy();
  });

  it('reaches the column headings in a third of the rows it used to', async () => {
    const sheet = await render();
    let headerRow = 0;
    sheet.eachRow((row, number) => {
      if (!headerRow && String(row.getCell(1).value ?? '') === 'Invoice No') headerRow = number;
    });
    // It was eighteen. Anything approaching that is a page of preamble before
    // the first invoice, with the figures people opened the file for below it.
    expect(headerRow).toBeLessThanOrEqual(8);
    expect(headerRow).toBeGreaterThan(3);
  });
});
