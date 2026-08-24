'use strict';

/**
 * Master-data integrity hardening (M03/M04).
 *
 * Three problems, all found by tracing masters end to end:
 *
 * 1. **Two foreign keys onto `products` were ON DELETE CASCADE.** Deleting a
 *    product that had never been transacted silently deleted every BOM version
 *    for it (and their lines, which cascade in turn) and every price-list row.
 *    Nothing warned, and the recipe history a production entry needs to explain
 *    itself was simply gone. Both become RESTRICT, matching every other
 *    transactional reference in the schema. The application-level guard in
 *    ProductsService.deleteProduct is what produces a readable message; this is
 *    the backstop that holds even for a direct SQL delete.
 *
 * 2. **`parties` had no uniqueness at all** beyond its primary key — no
 *    constraint on code, none on GSTIN. Two "Acme Traders" rows split one
 *    customer's receivables across two ledgers, and neither balance is right.
 *    Both indexes are partial (`WHERE ... IS NOT NULL`) because both columns
 *    are optional; a plain unique index would let exactly one party per tenant
 *    omit a code. GSTIN is unique per (tenant, partyType) rather than per
 *    tenant: the same legal entity is routinely both a customer and a supplier,
 *    and blocking that would force a fake GSTIN onto one of the two records.
 *
 * 3. **Master list queries had no supporting indexes.** `product_categories`
 *    had no unique code either. The rest are the (tenantId, <filter>) pairs the
 *    list screens and the new dependency checks actually query on — foreign
 *    keys do not create indexes in Postgres, so a "can I delete this product?"
 *    check was ~20 sequential scans.
 *
 * Idempotent throughout, matching the convention the phase migrations set.
 */

const indexExists = async (queryInterface, table, name) => {
  const tables = await queryInterface.showAllTables();
  if (!tables.includes(table)) return true;
  const existing = await queryInterface.showIndex(table);
  return existing.some((i) => i.name === name);
};

const addIndexIfMissing = async (queryInterface, table, fields, options) => {
  if (await indexExists(queryInterface, table, options.name)) return;
  await queryInterface.addIndex(table, fields, options);
};

/** Replaces a foreign key's ON DELETE action, by name. */
const retargetForeignKey = async (queryInterface, Sequelize, { table, column, target, constraint }) => {
  const tables = await queryInterface.showAllTables();
  if (!tables.includes(table)) return;

  await queryInterface.sequelize.query(`ALTER TABLE "${table}" DROP CONSTRAINT IF EXISTS "${constraint}"`);
  await queryInterface.addConstraint(table, {
    fields: [column],
    type: 'foreign key',
    name: constraint,
    references: { table: target, field: 'id' },
    onDelete: 'RESTRICT',
    onUpdate: 'CASCADE',
  });
};

/**
 * Partial unique indexes need raw SQL — queryInterface.addIndex serialises a
 * `where` into a form Postgres rejects for expressions like IS NOT NULL.
 */
const addPartialUnique = async (queryInterface, name, table, columns, predicate) => {
  if (await indexExists(queryInterface, table, name)) return;
  await queryInterface.sequelize.query(
    `CREATE UNIQUE INDEX "${name}" ON "${table}" (${columns.map((c) => `"${c}"`).join(', ')}) WHERE ${predicate}`
  );
};

module.exports = {
  async up(queryInterface, Sequelize) {
    // --- 1. CASCADE -> RESTRICT on the two references that destroyed history ---
    await retargetForeignKey(queryInterface, Sequelize, {
      table: 'mix_designs',
      column: 'productId',
      target: 'products',
      constraint: 'mix_designs_productId_fkey',
    });
    await retargetForeignKey(queryInterface, Sequelize, {
      table: 'price_list_items',
      column: 'productId',
      target: 'products',
      constraint: 'price_list_items_productId_fkey',
    });

    // --- 2. Duplicate prevention on party identity ---
    await addPartialUnique(queryInterface, 'parties_tenant_code_unique', 'parties', ['tenantId', 'code'], '"code" IS NOT NULL');
    await addPartialUnique(
      queryInterface,
      'parties_tenant_type_gstin_unique',
      'parties',
      ['tenantId', 'partyType', 'gstin'],
      '"gstin" IS NOT NULL'
    );
    await addPartialUnique(
      queryInterface,
      'product_categories_tenant_code_unique',
      'product_categories',
      ['tenantId', 'code'],
      '"code" IS NOT NULL'
    );

    // --- 3. Indexes the master screens and dependency checks query on ---
    const INDEXES = [
      ['parties', ['tenantId', 'status'], 'parties_tenant_status_idx'],
      ['parties', ['tenantId', 'name'], 'parties_tenant_name_idx'],
      ['products', ['tenantId', 'status'], 'products_tenant_status_idx'],
      ['products', ['tenantId', 'categoryId'], 'products_tenant_category_idx'],
      ['products', ['tenantId', 'productType'], 'products_tenant_type_idx'],
      ['products', ['tenantId', 'name'], 'products_tenant_name_idx'],
      ['products', ['tenantId', 'uomId'], 'products_tenant_uom_idx'],
      ['products', ['tenantId', 'hsnId'], 'products_tenant_hsn_idx'],
      ['product_categories', ['tenantId', 'parentId'], 'product_categories_tenant_parent_idx'],
      ['mix_designs', ['tenantId', 'productId', 'status'], 'mix_designs_tenant_product_status_idx'],
      ['mix_design_lines', ['tenantId', 'mixDesignId'], 'mix_design_lines_tenant_design_idx'],
      ['mix_design_lines', ['tenantId', 'rawMaterialProductId'], 'mix_design_lines_tenant_raw_material_idx'],
      ['mix_design_lines', ['tenantId', 'uomId'], 'mix_design_lines_tenant_uom_idx'],
      ['party_addresses', ['tenantId', 'partyId'], 'party_addresses_tenant_party_idx'],
      ['price_list_items', ['tenantId', 'productId'], 'price_list_items_tenant_product_idx'],
      ['price_lists', ['tenantId', 'partyId'], 'price_lists_tenant_party_idx'],
      ['uom_conversions', ['tenantId', 'fromUomId'], 'uom_conversions_tenant_from_idx'],
      ['uom_conversions', ['tenantId', 'toUomId'], 'uom_conversions_tenant_to_idx'],
    ];
    for (const [table, fields, name] of INDEXES) {
      await addIndexIfMissing(queryInterface, table, fields, { name });
    }
  },

  async down(queryInterface) {
    const drop = [
      'parties_tenant_code_unique',
      'parties_tenant_type_gstin_unique',
      'product_categories_tenant_code_unique',
      'parties_tenant_status_idx',
      'parties_tenant_name_idx',
      'products_tenant_status_idx',
      'products_tenant_category_idx',
      'products_tenant_type_idx',
      'products_tenant_name_idx',
      'products_tenant_uom_idx',
      'products_tenant_hsn_idx',
      'product_categories_tenant_parent_idx',
      'mix_designs_tenant_product_status_idx',
      'mix_design_lines_tenant_design_idx',
      'mix_design_lines_tenant_raw_material_idx',
      'mix_design_lines_tenant_uom_idx',
      'party_addresses_tenant_party_idx',
      'price_list_items_tenant_product_idx',
      'price_lists_tenant_party_idx',
      'uom_conversions_tenant_from_idx',
      'uom_conversions_tenant_to_idx',
    ];
    for (const name of drop) {
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${name}"`).catch(() => {});
    }
  },
};
