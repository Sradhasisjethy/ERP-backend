const { products, productCategories, uoms, hsnCodes } = require('./configs/products.config');
const { parties } = require('./configs/parties.config');
const { vehicles } = require('./configs/vehicles.config');
const { accounts } = require('./configs/ledger.config');
const { leaveTypes } = require('./configs/hr.config');
const { offices, departments } = require('./configs/organization.config');
const { priceListItems } = require('./configs/pricing.config');
const { NotFoundError } = require('../../core/AppError');

/**
 * Every master that can be imported and exported, in the order it should be
 * imported in.
 *
 * The order is not cosmetic: a Products file names a UoM by its code, and a
 * Vehicles file names a transporter by its party code. Importing down this list
 * means every reference a file makes has already been created. The Instructions
 * sheet of each template says the same thing in words.
 *
 * Adding a master is one config object and one line here — see the developer
 * guide in docs/master-data-import-export.md.
 */
const CONFIGS = [
  uoms,
  hsnCodes,
  productCategories,
  products,
  parties,
  vehicles,
  priceListItems,
  offices,
  departments,
  accounts,
  leaveTypes,
];

const permissionsFor = (config) => ({
  read: `${config.resource}_READ`,
  create: `${config.resource}_CREATE`,
  update: `${config.resource}_MODIFY`,
  import: `${config.resource}_IMPORT`,
  export: `${config.resource}_EXPORT`,
});

/** The columns an upload is read with; export-only columns are written, never read. */
const importColumns = (config) => config.columns.filter((column) => !column.exportOnly);

/**
 * Drops rate columns for a user who may not see them (BR-27).
 *
 * A blanked column is not good enough: it still says a value exists and how
 * many records carry one. The report exporter takes the same line, and this
 * borrows its reasoning rather than inventing a second rule.
 */
const visibleColumns = (config, { canViewRates }) =>
  canViewRates ? config.columns : config.columns.filter((column) => !column.rate);

/**
 * Refuses a misconfigured module at startup, not at the first upload.
 *
 * Both mistakes this catches have already happened once: a config naming a
 * service export that does not exist (`VehiclesService` for `VehicleService`),
 * and one missing a writer entirely. Either way the module looks fine — the
 * sample downloads, the preview renders — until somebody presses Import and
 * gets "Cannot read properties of undefined". A require-time check turns that
 * into a failure nobody can deploy past.
 */
const assertWellFormed = (config) => {
  const missing = ['key', 'label', 'fileBase', 'resource', 'businessKey', 'businessKeyHeader']
    .filter((field) => !config[field]);
  if (missing.length) throw new Error(`Master data config is missing ${missing.join(', ')}: ${JSON.stringify(config.key)}`);
  if (!Array.isArray(config.columns) || !config.columns.length) throw new Error(`${config.key}: no columns`);
  if (!Array.isArray(config.examples) || config.examples.length < 2) {
    throw new Error(`${config.key}: the sample workbook needs two worked example rows`);
  }
  if (typeof config.load !== 'function') throw new Error(`${config.key}: load must be a function`);

  // A module either writes row by row through the module services, or takes the
  // whole set at once (price list items, whose service replaces them together).
  const perRow = typeof config.create === 'function' && typeof config.update === 'function';
  if (!perRow && typeof config.commitAll !== 'function') {
    throw new Error(`${config.key}: needs either create and update, or commitAll — check the service export names`);
  }

  for (const column of config.columns) {
    if (!column.header || !column.field) throw new Error(`${config.key}: a column is missing its header or field`);
    if (column.type === 'reference' && !column.reference?.master) {
      throw new Error(`${config.key}: "${column.header}" is a reference with no master to look it up in`);
    }
  }
};

CONFIGS.forEach(assertWellFormed);

const byKey = new Map(CONFIGS.map((config) => [config.key, config]));

const getConfig = (key) => {
  const config = byKey.get(String(key || '').trim());
  if (!config) throw new NotFoundError(`There is no master data import called "${key}"`);
  return config;
};

/** What the UI lists — no columns, just what exists and what it needs. */
const describe = (config) => ({
  key: config.key,
  label: config.label,
  resource: config.resource,
  permissions: permissionsFor(config),
  businessKeyHeader: config.businessKeyHeader,
  contextParam: config.context?.param || null,
  ratesRequired: !!config.ratesRequired,
});

module.exports = { CONFIGS, getConfig, describe, permissionsFor, importColumns, visibleColumns, assertWellFormed };
