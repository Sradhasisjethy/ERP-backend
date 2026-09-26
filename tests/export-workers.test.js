const { PassThrough } = require('stream');
const ExcelJS = require('exceljs');
const { renderInWorker, shutdownExportWorkers, exportWorkerStats } = require('../src/api/reports/export/workers');

/**
 * Exports are built on worker threads (src/api/reports/export/workers.js).
 * What must hold: the bytes that come back are the same file the in-process
 * builders would have written, a client that disconnects does not leave a
 * thread grinding on for nobody, and a worker that has finished is kept for
 * the next export rather than paid for again.
 *
 * No database: the pool only ever sees plain data.
 */

const columns = [
  { key: 'invoiceNo', header: 'Invoice', type: 'code', align: 'left', width: 14 },
  { key: 'customer', header: 'Customer', type: 'text', align: 'left', width: 24 },
  { key: 'gross', header: 'Gross', type: 'money', align: 'right', width: 16, total: true },
];

const payload = (rowCount) => ({
  definition: { name: 'Sales Register', description: 'Every posted invoice' },
  columns,
  rows: Array.from({ length: rowCount }, (_, i) => ({
    invoiceNo: `INV/${String(i + 1).padStart(4, '0')}`,
    customer: `Customer ${i + 1}`,
    gross: (i + 1) * 10000,
  })),
  summary: { invoices: rowCount },
  metrics: [{ key: 'invoices', label: 'Invoices', type: 'int' }],
  meta: {
    organizationName: 'Infideep Precast',
    periodLabel: 'All dates',
    locationLabel: 'All permitted locations',
    filterLabel: '',
    generatedAt: new Date('2026-09-25T10:00:00Z'),
    userName: 'Asha Admin',
    canViewRates: true,
  },
  settings: { currency: 'INR', currencySymbol: '₹', locale: 'en-IN', decimalPlaces: 2 },
});

const collect = (run) =>
  new Promise((resolve, reject) => {
    const sink = new PassThrough();
    const chunks = [];
    sink.on('data', (chunk) => chunks.push(chunk));
    sink.on('end', () => resolve(Buffer.concat(chunks)));
    sink.on('error', reject);
    run(sink).catch(reject);
  });

afterAll(() => shutdownExportWorkers());

describe('Exports built on a worker thread', () => {
  it('returns a real workbook with the rows and the totals formula intact', async () => {
    const buffer = await collect((sink) => renderInWorker('xlsx', payload(250), sink));

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.worksheets[0];
    expect(sheet.name).toBe('Sales Register');

    const headerRow = [...Array(sheet.rowCount).keys()].map((i) => i + 1)
      .find((n) => sheet.getRow(n).getCell(1).value === 'Invoice');
    expect(headerRow).toBeDefined();
    expect(sheet.getRow(headerRow + 1).getCell(1).value).toBe('INV/0001');
    expect(sheet.getRow(headerRow + 250).getCell(1).value).toBe('INV/0250');
    // Money arrives as a number in rupees, so the reader can re-total it.
    expect(sheet.getRow(headerRow + 1).getCell(3).value).toBe(100);
    const totals = sheet.getRow(headerRow + 251);
    expect(totals.getCell(1).value).toBe('TOTAL');
    expect(totals.getCell(3).value.formula).toMatch(/^SUM\(C\d+:C\d+\)$/);
  });

  it('returns a PDF', async () => {
    const buffer = await collect((sink) => renderInWorker('pdf', payload(40), sink));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
    expect(buffer.length).toBeGreaterThan(2000);
  });

  it('keeps the finished worker for the next export instead of spawning again', async () => {
    await collect((sink) => renderInWorker('xlsx', payload(5), sink));
    const before = exportWorkerStats();
    expect(before.idle).toBeGreaterThanOrEqual(1);
    await collect((sink) => renderInWorker('xlsx', payload(5), sink));
    const after = exportWorkerStats();
    expect(after.idle + after.busy).toBe(before.idle + before.busy);
  });

  it('stops when the client goes away rather than finishing a file for nobody', async () => {
    const sink = new PassThrough();
    sink.resume();
    const pending = renderInWorker('xlsx', payload(20000), sink);
    // The download is abandoned almost at once.
    setTimeout(() => sink.destroy(), 50);
    await expect(pending).rejects.toThrow(/connection closed/);
  });

  it('refuses a format it has no builder for, without taking the thread down', async () => {
    await expect(collect((sink) => renderInWorker('docx', payload(1), sink))).rejects.toThrow(/No export builder/);
    // And the pool still works afterwards.
    const buffer = await collect((sink) => renderInWorker('pdf', payload(3), sink));
    expect(buffer.subarray(0, 5).toString()).toBe('%PDF-');
  });
});
