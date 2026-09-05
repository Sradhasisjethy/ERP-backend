'use strict';

/**
 * Product bundles and accessory auto-attach — Phase 1 schema.
 * See docs/specs/bundle-kitting.md.
 *
 * Three deviations from the spec's §3 DDL, all recorded in its §0b:
 *
 *  - `tenantId` on every table, first in every index. The spec omitted it; this
 *    system is multi-tenant, and without it the second tenant to create a rule
 *    coded STARTER is rejected by the first tenant's row.
 *  - Money is BIGINT paise, not DECIMAL(18,4). Every other money column in this
 *    schema is paise, and a lone decimal one is a defect vector at every sum.
 *  - camelCase quoted identifiers and `sales_order_lines` as the target, since
 *    there is no unified `sales_document_line` here.
 *
 * Reversible, and the ALTER only appends nullable columns plus two with
 * defaults, so it does not rewrite the live sales_order_lines table.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();

    // ---- reason codes (referenced by suppressions) ------------------------
    if (!tables.includes('override_reason_codes')) {
      await queryInterface.createTable('override_reason_codes', {
        code: { type: Sequelize.STRING(50), primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        label: { type: Sequelize.STRING(200), allowNull: false },
        requiresNote: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('override_reason_codes', ['tenantId', 'isActive'], {
        name: 'override_reason_codes_tenant_active_idx',
      });
    }

    // ---- rule header ------------------------------------------------------
    if (!tables.includes('bundle_rules')) {
      await queryInterface.createTable('bundle_rules', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        code: { type: Sequelize.STRING(50), allowNull: false },
        name: { type: Sequelize.STRING(200), allowNull: false },
        parentProductId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },

        // Only EXPLODED and INDEPENDENT are implemented. The columns exist so
        // the assembled-kit and composite-supply work has somewhere to land
        // without another migration against a live table.
        bundleType: { type: Sequelize.ENUM('EXPLODED', 'ASSEMBLED'), allowNull: false, defaultValue: 'EXPLODED' },
        taxTreatment: { type: Sequelize.ENUM('INDEPENDENT', 'COMPOSITE', 'MIXED'), allowNull: false, defaultValue: 'INDEPENDENT' },

        version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
        status: { type: Sequelize.ENUM('DRAFT', 'ACTIVE', 'SUPERSEDED', 'ARCHIVED'), allowNull: false, defaultValue: 'DRAFT' },
        effectiveFrom: { type: Sequelize.DATEONLY, allowNull: false },
        effectiveTo: { type: Sequelize.DATEONLY, allowNull: true },
        priority: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 100 },

        publishedBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
        publishedAt: { type: Sequelize.DATE, allowNull: true },
        createdBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
        updatedBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });

      // tenantId first: a code is unique within a tenant, not across the platform.
      await queryInterface.addIndex('bundle_rules', ['tenantId', 'code', 'version'], {
        unique: true,
        name: 'bundle_rules_tenant_code_version_unique',
      });
      // The resolution query: which rule applies to this product on this date.
      await queryInterface.addIndex('bundle_rules', ['tenantId', 'parentProductId', 'status', 'effectiveFrom', 'effectiveTo'], {
        name: 'bundle_rules_lookup_idx',
      });
    }

    // ---- rule components --------------------------------------------------
    if (!tables.includes('bundle_components')) {
      await queryInterface.createTable('bundle_components', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        bundleRuleId: { type: Sequelize.UUID, allowNull: false, references: { model: 'bundle_rules', key: 'id' }, onDelete: 'CASCADE' },
        componentProductId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },

        quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
        // PROPORTIONAL scales with the parent; FIXED does not, however many
        // parents are sold (one installation kit per order, not per unit).
        scalingMode: { type: Sequelize.ENUM('PROPORTIONAL', 'FIXED'), allowNull: false, defaultValue: 'PROPORTIONAL' },
        uomId: { type: Sequelize.UUID, allowNull: false, references: { model: 'uoms', key: 'id' }, onDelete: 'RESTRICT' },

        isMandatory: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
        // false = offered in the optional picker, never auto-added.
        defaultSelected: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        sequence: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },

        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });

      await queryInterface.addIndex('bundle_components', ['bundleRuleId', 'componentProductId'], {
        unique: true,
        name: 'bundle_components_rule_product_unique',
      });
    }

    // ---- suppression tombstones ------------------------------------------
    if (!tables.includes('bundle_component_suppressions')) {
      await queryInterface.createTable('bundle_component_suppressions', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        salesOrderId: { type: Sequelize.UUID, allowNull: false, references: { model: 'sales_orders', key: 'id' }, onDelete: 'CASCADE' },
        parentLineId: { type: Sequelize.UUID, allowNull: false, references: { model: 'sales_order_lines', key: 'id' }, onDelete: 'CASCADE' },
        componentProductId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },

        reasonCode: { type: Sequelize.STRING(50), allowNull: false, references: { model: 'override_reason_codes', key: 'code' }, onDelete: 'RESTRICT' },
        reasonNote: { type: Sequelize.TEXT, allowNull: true },
        suppressedBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
        suppressedAt: { type: Sequelize.DATE, allowNull: false },

        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });

      // Invariant 8: identity is (parentLineId, componentProductId), never
      // (orderId, productId) — two lines of the same product on one order must
      // suppress independently.
      await queryInterface.addIndex('bundle_component_suppressions', ['parentLineId', 'componentProductId'], {
        unique: true,
        name: 'bundle_suppressions_parent_product_unique',
      });
      await queryInterface.addIndex('bundle_component_suppressions', ['tenantId', 'salesOrderId'], {
        name: 'bundle_suppressions_tenant_order_idx',
      });
    }

    // ---- append-only audit ------------------------------------------------
    if (!tables.includes('bundle_override_audits')) {
      await queryInterface.createTable('bundle_override_audits', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        salesOrderId: { type: Sequelize.UUID, allowNull: false },
        lineId: { type: Sequelize.UUID, allowNull: true },
        parentLineId: { type: Sequelize.UUID, allowNull: true },
        componentProductId: { type: Sequelize.UUID, allowNull: true },

        action: {
          type: Sequelize.ENUM('QTY_CHANGED', 'PRICE_CHANGED', 'SUPPRESSED', 'RESTORED', 'OPTIONAL_ADDED', 'RESET'),
          allowNull: false,
        },
        beforeValue: { type: Sequelize.JSONB, allowNull: true },
        afterValue: { type: Sequelize.JSONB, allowNull: true },
        reasonCode: { type: Sequelize.STRING(50), allowNull: true },
        reasonNote: { type: Sequelize.TEXT, allowNull: true },

        // No FK on the document columns: this table outlives what it describes.
        // An audit row that vanishes when the order is deleted is not an audit.
        actorId: { type: Sequelize.UUID, allowNull: true },
        occurredAt: { type: Sequelize.DATE, allowNull: false },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });

      await queryInterface.addIndex('bundle_override_audits', ['tenantId', 'salesOrderId', 'occurredAt'], {
        name: 'bundle_audits_tenant_order_time_idx',
      });
    }

    // ---- sales order line: bundle columns ---------------------------------
    const lineCols = await queryInterface.describeTable('sales_order_lines');

    const addColumn = async (name, definition) => {
      if (!lineCols[name]) await queryInterface.addColumn('sales_order_lines', name, definition);
    };

    await addColumn('lineRole', { type: Sequelize.ENUM('PARENT', 'COMPONENT', 'STANDALONE'), allowNull: false, defaultValue: 'STANDALONE' });
    await addColumn('parentLineId', { type: Sequelize.UUID, allowNull: true, references: { model: 'sales_order_lines', key: 'id' }, onDelete: 'CASCADE' });
    await addColumn('bundleRuleId', { type: Sequelize.UUID, allowNull: true, references: { model: 'bundle_rules', key: 'id' }, onDelete: 'RESTRICT' });
    await addColumn('bundleRuleVersion', { type: Sequelize.INTEGER, allowNull: true });

    // Invariant 3: a historical document is never re-resolved from live master
    // data. The rule as it stood is frozen here at expansion time.
    await addColumn('bundleSnapshot', { type: Sequelize.JSONB, allowNull: true });

    // Two fields, not one enum: `origin` records how the line got here and
    // never changes; `syncState` records whether the system still controls it
    // and changes freely. Merging them makes the transition table unwritable.
    await addColumn('origin', { type: Sequelize.ENUM('RULE_AUTO', 'RULE_OPTIONAL', 'MANUAL'), allowNull: false, defaultValue: 'MANUAL' });
    await addColumn('syncState', { type: Sequelize.ENUM('SYNCED', 'QTY_OVERRIDDEN', 'PRICE_OVERRIDDEN', 'DETACHED'), allowNull: false, defaultValue: 'SYNCED' });

    // The only reliable answer to "has the user touched this line?".
    await addColumn('systemQty', { type: Sequelize.DECIMAL(14, 4), allowNull: true });
    await addColumn('systemUnitPricePaise', { type: Sequelize.BIGINT, allowNull: true });

    const idx = await queryInterface.showIndex('sales_order_lines');
    if (!idx.some((i) => i.name === 'sales_order_lines_parent_idx')) {
      await queryInterface.addIndex('sales_order_lines', ['parentLineId'], { name: 'sales_order_lines_parent_idx' });
    }
  },

  async down(queryInterface) {
    for (const col of [
      'systemUnitPricePaise', 'systemQty', 'syncState', 'origin',
      'bundleSnapshot', 'bundleRuleVersion', 'bundleRuleId', 'parentLineId', 'lineRole',
    ]) {
      await queryInterface.removeColumn('sales_order_lines', col).catch(() => {});
    }
    for (const t of [
      'bundle_override_audits', 'bundle_component_suppressions',
      'bundle_components', 'bundle_rules', 'override_reason_codes',
    ]) {
      await queryInterface.dropTable(t).catch(() => {});
    }
    // Postgres cannot drop enum values; the types created above are dropped
    // with their tables, and the sales_order_lines ones are removed by
    // removeColumn on this dialect.
  },
};
