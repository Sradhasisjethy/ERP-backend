/**
 * Reference resolution for import.
 *
 * A spreadsheet names another master by its code — "NOS", "6810", "BBSR" —
 * because a UUID is not something a user can type. Each loader turns one master
 * into a `Map<UPPERCASED code, id>`, fetched **once per import** rather than
 * once per row: a 5,000-row product file references the UoM master 5,000 times
 * and must not cost 5,000 queries.
 *
 * Only the masters a file actually references are loaded, so importing UoMs
 * touches nothing else.
 */

const { Uom } = require('../products/uom.model');
const { HsnCode } = require('../products/hsnCode.model');
const { ProductCategory } = require('../products/productCategory.model');
const { Product } = require('../products/product.model');
const { Party } = require('../parties/party.model');
const { Account } = require('../ledger/account.model');
const { Organization } = require('../organization/organization.model');
const { Office } = require('../organization/office.model');
const { Department } = require('../organization/department.model');

const byCode = (rows, field = 'code') => {
  const map = new Map();
  for (const row of rows) {
    const key = String(row[field] ?? '').trim().toUpperCase();
    // First wins. Where a master allows duplicate codes (they are unique per
    // tenant only where an index says so), a second row must not quietly
    // redirect every reference to a different record.
    if (key && !map.has(key)) map.set(key, row.id);
  }
  return map;
};

const LOADERS = {
  uoms: async () => byCode(await Uom.findAll({ attributes: ['id', 'code'] })),
  hsnCodes: async () => byCode(await HsnCode.findAll({ attributes: ['id', 'code'] })),
  productCategories: async () => byCode(await ProductCategory.findAll({ attributes: ['id', 'code'] })),
  products: async () => byCode(await Product.findAll({ attributes: ['id', 'code'] })),
  accounts: async () => byCode(await Account.findAll({ attributes: ['id', 'code'] })),
  organizations: async () => byCode(await Organization.findAll({ attributes: ['id', 'code'] })),
  offices: async () => byCode(await Office.findAll({ attributes: ['id', 'code'] })),
  departments: async () => byCode(await Department.findAll({ attributes: ['id', 'code'] })),
  // Transporters are parties; a vehicle names one by its party code.
  parties: async () => byCode(await Party.findAll({ attributes: ['id', 'code'] })),
};

/** Loads only the masters the given columns reference. */
const loadLookups = async (columns) => {
  const needed = [...new Set(columns.filter((c) => c.type === 'reference').map((c) => c.reference.master))];
  const entries = await Promise.all(
    needed.map(async (master) => {
      const loader = LOADERS[master];
      if (!loader) throw new Error(`No lookup loader registered for "${master}"`);
      return [master, await loader()];
    })
  );
  return Object.fromEntries(entries);
};

module.exports = { loadLookups, LOADERS, byCode };
