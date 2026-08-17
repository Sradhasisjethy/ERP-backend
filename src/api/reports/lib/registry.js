const { REPORT_CATEGORIES } = require('../../../utils/permissionCatalog');

/**
 * The report catalog.
 *
 * One definition per report, in one place, describing everything the rest of
 * the module needs: what it is called, who may see it, which filters apply,
 * which columns exist, which of those are sortable, what the summary tiles
 * are, and how to build the query. The screen, the Excel export and the PDF
 * export are all driven from the same definition, so a report cannot show one
 * thing on screen and another in the download.
 */

/**
 * UI categories (the tabs). Several share a permission key deliberately —
 * "Stock Ageing" is inventory data, and payments/expenses are finance data —
 * so 14 tabs are governed by 11 grants. See utils/permissionCatalog.js.
 */
const CATEGORIES = Object.freeze([
  { id: 'sales', name: 'Sales', permissionKey: 'REPORT_SALES', description: 'Invoiced sales by document, customer, product and location' },
  { id: 'orders', name: 'Orders', permissionKey: 'REPORT_ORDER', description: 'Sales order book, fulfilment progress and pending delivery' },
  { id: 'purchase', name: 'Purchase', permissionKey: 'REPORT_PURCHASE', description: 'Goods received and vendor invoicing' },
  { id: 'production', name: 'Production', permissionKey: 'REPORT_PRODUCTION', description: 'Plan against actual output, material consumption and contractor work' },
  { id: 'inventory', name: 'Inventory', permissionKey: 'REPORT_INVENTORY', description: 'Stock position, movement, transfers and adjustments' },
  { id: 'ageing', name: 'Stock Ageing', permissionKey: 'REPORT_INVENTORY', description: 'How long stock has been sitting, against the configured ageing policy' },
  { id: 'customer', name: 'Customer', permissionKey: 'REPORT_CUSTOMER', description: 'Customer activity, statements and outstanding balances' },
  { id: 'vendor', name: 'Vendor', permissionKey: 'REPORT_VENDOR', description: 'Vendor activity, statements and outstanding balances' },
  { id: 'contractor', name: 'Contractor', permissionKey: 'REPORT_CONTRACTOR', description: 'Job-work output, statements and dues' },
  { id: 'labour', name: 'Labour', permissionKey: 'REPORT_LABOUR', description: 'Attendance, wages accrued and labour dues' },
  { id: 'payment', name: 'Payments', permissionKey: 'REPORT_FINANCE', description: 'Money in and out, by mode and by collection' },
  { id: 'expense', name: 'Expenses', permissionKey: 'REPORT_FINANCE', description: 'Factory expenses by document and by category' },
  { id: 'finance', name: 'Finance', permissionKey: 'REPORT_FINANCE', description: 'Cash flow, day book, receivables and payables' },
  { id: 'analytics', name: 'Analytics', permissionKey: 'REPORT_ANALYTICS', description: 'Cross-module management summaries' },
]);

const CATEGORY_BY_ID = new Map(CATEGORIES.map((c) => [c.id, c]));

const REPORTS = new Map();
const REPORTS_BY_PATH = new Map();

/** Filters the whole module understands. A report opts into the ones it needs. */
const FILTER_KEYS = Object.freeze([
  'dateFrom',
  'dateTo',
  'factoryId',
  'customerId',
  'vendorId',
  'contractorId',
  'labourId',
  'partyId',
  'productId',
  'categoryId',
  'status',
  'paymentStatus',
  'movementType',
  'referenceType',
  'productType',
  'stockStatus',
  'ageingClass',
  'attendanceStatus',
  'expenseCategory',
  'paymentMode',
  'direction',
  'accountKey',
  'overdueOnly',
]);

const defineReport = (definition) => {
  const category = CATEGORY_BY_ID.get(definition.category);
  if (!category) throw new Error(`Report "${definition.id}" has unknown category "${definition.category}"`);

  for (const filter of definition.filters || []) {
    if (!FILTER_KEYS.includes(filter)) throw new Error(`Report "${definition.id}" declares unknown filter "${filter}"`);
  }

  const report = Object.freeze({
    kind: 'table',
    filters: [],
    defaultFilters: {},
    columns: [],
    summary: [],
    searchFields: [],
    ...definition,
    permissions: {
      view: `${category.permissionKey}_READ`,
      export: `${category.permissionKey}_EXPORT`,
      ...(definition.permissions || {}),
    },
    path: `${definition.category}/${definition.slug}`,
  });

  if (REPORTS.has(report.id)) throw new Error(`Duplicate report id "${report.id}"`);
  REPORTS.set(report.id, report);
  REPORTS_BY_PATH.set(report.path, report);
  return report;
};

const getReport = (id) => REPORTS.get(id) || null;
const getReportByPath = (category, slug) => REPORTS_BY_PATH.get(`${category}/${slug}`) || null;
const allReports = () => [...REPORTS.values()];

module.exports = { CATEGORIES, CATEGORY_BY_ID, FILTER_KEYS, defineReport, getReport, getReportByPath, allReports, REPORT_CATEGORIES };
