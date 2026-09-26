const { Organization } = require('../../organization/organization.model');
const { Tenant } = require('../../organization/tenant.model');
const { Factory } = require('../../factory/factory.model');
const { Party } = require('../../parties/party.model');
const { Product } = require('../../products/product.model');
const { ProductCategory } = require('../../products/productCategory.model');
const { hasViewRates } = require('../../../utils/fieldMasking');
const { executeReport } = require('../lib/runner');
const { resolveFormatSettings, formatDate, formatValue, humanise } = require('./format');
const { renderInWorker } = require('./workers');

/**
 * Export orchestration.
 *
 * The only thing that separates an export from the on-screen report is the page
 * size: both call `executeReport` with the same definition and the same
 * validated filters, so an export cannot show a column, a row or a total the
 * screen would have withheld. Column-level permission stripping happens inside
 * the runner, before this file ever sees a row — there is no path here that
 * could re-add a denied field.
 */

const FORMATS = Object.freeze(['xlsx', 'pdf', 'csv']);

const CONTENT_TYPE = {
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pdf: 'application/pdf',
  csv: 'text/csv; charset=utf-8',
};

/**
 * Turns filter ids into the names a human recognises, so the export header says
 * "Customer: Bhuasuni Traders" rather than a UUID. Unresolvable ids fall back
 * to the raw value rather than disappearing.
 */
const describeFilters = async (definition, params) => {
  const parts = [];
  const lookups = [];

  const named = (Model, id, label) => {
    if (!id) return;
    lookups.push(
      Model.findByPk(id, { attributes: ['id', 'name'] })
        .then((row) => parts.push(`${label}: ${row?.name || id}`))
        .catch(() => parts.push(`${label}: ${id}`))
    );
  };

  named(Party, params.customerId, 'Customer');
  named(Party, params.vendorId, 'Vendor');
  named(Party, params.contractorId, 'Contractor');
  named(Party, params.labourId, 'Labour');
  named(Party, params.partyId, 'Party');
  named(Product, params.productId, 'Product');
  named(ProductCategory, params.categoryId, 'Category');

  const plain = {
    status: 'Status',
    paymentStatus: 'Payment Status',
    movementType: 'Movement Type',
    referenceType: 'Reference Type',
    productType: 'Product Type',
    stockStatus: 'Stock Status',
    ageingClass: 'Ageing',
    attendanceStatus: 'Attendance',
    expenseCategory: 'Expense Category',
    paymentMode: 'Payment Mode',
    direction: 'Direction',
    accountKey: 'Account',
  };
  for (const [key, label] of Object.entries(plain)) {
    if (params[key]) parts.push(`${label}: ${humanise(params[key])}`);
  }
  if (params.overdueOnly === true || params.overdueOnly === 'true') parts.push('Overdue only');
  if (params.search) parts.push(`Search: "${params.search}"`);

  await Promise.all(lookups);
  return parts.join('  ·  ');
};

/**
 * Who generated this. The JWT carries only ids (userId, tenantId, role,
 * permissions — see middlewares/auth.js), so the name is looked up rather than
 * read off `req.user`, which has no name on it.
 */
const resolveUserName = async (req) => {
  const { User } = require('../../users/user.model');
  const user = await User.findByPk(req.user.userId, { attributes: ['id', 'firstName', 'lastName', 'email'] }).catch(() => null);
  if (!user) return 'Unknown user';
  return [user.firstName, user.lastName].filter(Boolean).join(' ') || user.email || 'Unknown user';
};

/** Organisation identity for the header — the legal entity, then the tenant. */
/**
 * Whose business this report is about.
 *
 * It used to be whatever organisation the signed-in user happened to be
 * attached to. That put "Acme Global" — an organisation deactivated long ago —
 * at the top of a sales report in which every invoice belonged to Infideep
 * Precast, because one login still pointed at the old shell. A report is a
 * business document; naming the wrong company on it is not a cosmetic problem.
 *
 * So it is answered from the data first and the login last:
 *
 *   1. the organisation that owns the plant the report is filtered to
 *   2. the one organisation that owns every plant the tenant has, if there is
 *      only one — which is the ordinary case
 *   3. the user's own organisation, but only while it is still active
 *   4. the tenant
 */
const resolveOrganizationName = async (req, params = {}) => {
  if (params.factoryId) {
    const factory = await Factory.findByPk(params.factoryId, {
      attributes: ['id', 'organizationId'],
      include: [{ model: Organization, as: 'organization', attributes: ['id', 'name'] }],
    }).catch(() => null);
    if (factory?.organization?.name) return factory.organization.name;
  }

  const factories = await Factory.findAll({ attributes: ['organizationId'] }).catch(() => []);
  const owners = [...new Set(factories.map((factory) => factory.organizationId).filter(Boolean))];
  if (owners.length === 1) {
    const organization = await Organization.findByPk(owners[0], { attributes: ['id', 'name'] }).catch(() => null);
    if (organization?.name) return organization.name;
  }

  if (req.user?.organizationId) {
    const organization = await Organization.findByPk(req.user.organizationId, { attributes: ['id', 'name', 'status'] }).catch(() => null);
    if (organization?.name && organization.status === 'active') return organization.name;
  }

  // Tenant is not a BaseScopedModel, so it is fetched by id directly.
  const tenant = await Tenant.findByPk(req.user.tenantId, { attributes: ['id', 'name'] }).catch(() => null);
  return tenant?.name || 'Organization';
};

const resolveLocationLabel = async (params, allowedLabel) => {
  if (!params.factoryId) return allowedLabel;
  const factory = await Factory.findByPk(params.factoryId, { attributes: ['id', 'name'] }).catch(() => null);
  return factory?.name || params.factoryId;
};

const periodLabel = (params) => {
  if (params.dateFrom && params.dateTo) return `${formatDate(params.dateFrom)} to ${formatDate(params.dateTo)}`;
  if (params.dateFrom) return `From ${formatDate(params.dateFrom)}`;
  if (params.dateTo) return `Up to ${formatDate(params.dateTo)}`;
  return 'All dates';
};

/** RFC 4180 CSV, with the spreadsheet-formula injection guard the old exporter had. */
const csvEscape = (value) => {
  const text = String(value ?? '');
  // A leading =, +, - or @ makes Excel treat the cell as a formula, which is a
  // real injection vector when the data came from user input. Prefixing with a
  // quote neutralises it without changing what the reader sees.
  const safe = /^[=+\-@]/.test(text) ? `'${text}` : text;
  return /[",\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

const buildCsv = ({ definition, columns, rows, summary, metrics, meta, settings }) => {
  const lines = [
    csvEscape(meta.organizationName),
    csvEscape(definition.name),
    csvEscape(`Period: ${meta.periodLabel}`),
    csvEscape(`Location: ${meta.locationLabel}`),
  ];
  if (meta.filterLabel) lines.push(csvEscape(`Filters: ${meta.filterLabel}`));
  lines.push(csvEscape(`All amounts in ${settings.currency}`));
  lines.push(csvEscape(`Generated ${meta.generatedAt.toISOString()} by ${meta.userName}`));
  if (!meta.canViewRates) lines.push(csvEscape('Rate and amount columns are excluded for your role.'));
  lines.push('');

  if (metrics.length) {
    for (const item of metrics) lines.push([csvEscape(item.label), csvEscape(formatValue(summary[item.key], item, settings))].join(','));
    lines.push('');
  }

  lines.push(columns.map((c) => csvEscape(c.header)).join(','));
  for (const row of rows) lines.push(columns.map((c) => csvEscape(formatValue(row[c.key], c, settings))).join(','));

  // A UTF-8 BOM so Excel reads Indian names and symbols correctly rather than
  // as mojibake.
  return `\uFEFF${lines.join('\r\n')}`;
};

const slugify = (value) =>
  String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

/**
 * Runs the report at export scale and streams the chosen format to `res`.
 * Throws (rather than writing a partial file) if the result is too large — the
 * runner enforces that ceiling before a single row is rendered.
 */
const exportReport = async (definition, req, params, format, res) => {
  const result = await executeReport(definition, req, params, { mode: 'export' });
  const settings = await resolveFormatSettings();

  const [organizationName, filterLabel, userName] = await Promise.all([
    resolveOrganizationName(req, params),
    describeFilters(definition, params),
    resolveUserName(req),
  ]);
  const locationLabel = await resolveLocationLabel(params, 'All permitted locations');

  // Plain data only: this crosses into a worker thread by structured clone
  // (see workers.js), so the definition is reduced to what the file prints.
  const payload = {
    definition: { name: definition.name, description: definition.description || '' },
    columns: result.columns,
    rows: result.rows,
    summary: result.summary,
    metrics: result.metrics,
    settings,
    meta: {
      organizationName,
      periodLabel: periodLabel(params),
      locationLabel,
      filterLabel,
      generatedAt: new Date(),
      userName,
      canViewRates: hasViewRates(req),
      rowCountLabel: `${result.count.toLocaleString(settings.locale)} row(s).`,
    },
  };

  const filename = `${slugify(definition.name)}-${new Date().toISOString().slice(0, 10)}.${format}`;
  res.setHeader('Content-Type', CONTENT_TYPE[format]);
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  // The browser cannot read Content-Disposition on a cross-origin XHR unless it
  // is explicitly exposed, and the frontend downloads via XHR to carry the
  // session cookie — without this the file saves under a generated name.
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');

  if (format === 'csv') return res.send(buildCsv(payload));
  // XLSX and PDF are built on a worker thread and streamed back chunk by
  // chunk, so a large file slows its requester rather than every other user.
  return renderInWorker(format, payload, res);
};

module.exports = { exportReport, FORMATS, describeFilters, periodLabel, resolveOrganizationName };
