'use strict';

const STATUS_ACTIVE_INACTIVE = ['active', 'inactive'];

module.exports = {
  async up(queryInterface, Sequelize) {
    // --- M01: Factory & Financial Year setup ---
    await queryInterface.createTable('factories', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      organizationId: { type: Sequelize.UUID, allowNull: false, references: { model: 'organizations', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING, allowNull: false },
      code: { type: Sequelize.STRING, allowNull: false },
      address: { type: Sequelize.TEXT, allowNull: true },
      city: { type: Sequelize.STRING, allowNull: true },
      state: { type: Sequelize.STRING, allowNull: true },
      allowNegativeStock: { type: Sequelize.BOOLEAN, defaultValue: false },
      allowNegativeCash: { type: Sequelize.BOOLEAN, defaultValue: false },
      varianceThresholdPercent: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 5.0 },
      dispatchTolerancePercent: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
      status: { type: Sequelize.ENUM(...STATUS_ACTIVE_INACTIVE), defaultValue: 'active' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('factories', ['tenantId', 'code'], { unique: true, name: 'factories_tenant_code_unique' });

    await queryInterface.createTable('financial_years', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      code: { type: Sequelize.STRING, allowNull: false },
      startDate: { type: Sequelize.DATEONLY, allowNull: false },
      endDate: { type: Sequelize.DATEONLY, allowNull: false },
      isCurrent: { type: Sequelize.BOOLEAN, defaultValue: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('financial_years', ['tenantId', 'code'], { unique: true, name: 'financial_years_tenant_code_unique' });

    await queryInterface.createTable('user_factories', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'CASCADE' },
      userId: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' }, onDelete: 'CASCADE' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('user_factories', ['factoryId', 'userId'], { unique: true, name: 'user_factories_factory_user_unique' });

    // --- M16: Document numbering ---
    await queryInterface.createTable('document_series', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      documentType: { type: Sequelize.STRING, allowNull: false },
      factoryId: { type: Sequelize.UUID, allowNull: true, references: { model: 'factories', key: 'id' }, onDelete: 'CASCADE' },
      financialYearId: { type: Sequelize.UUID, allowNull: false, references: { model: 'financial_years', key: 'id' }, onDelete: 'CASCADE' },
      prefix: { type: Sequelize.STRING, allowNull: false },
      nextSequence: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      padding: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 4 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    // Postgres unique constraints treat every NULL as distinct, so a plain
    // unique index on (tenantId, documentType, financialYearId, factoryId)
    // would let factory-less series duplicate freely. Two partial indexes
    // cover both cases correctly (BR-31: one series per type/FY/factory).
    await queryInterface.addIndex('document_series', ['tenantId', 'documentType', 'financialYearId', 'factoryId'], {
      unique: true,
      where: { factoryId: { [Sequelize.Op.ne]: null } },
      name: 'document_series_unique_with_factory',
    });
    await queryInterface.addIndex('document_series', ['tenantId', 'documentType', 'financialYearId'], {
      unique: true,
      where: { factoryId: null },
      name: 'document_series_unique_without_factory',
    });

    // --- M17: Audit log ---
    await queryInterface.createTable('audit_logs', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      userId: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
      entityType: { type: Sequelize.STRING, allowNull: false },
      entityId: { type: Sequelize.UUID, allowNull: false },
      action: { type: Sequelize.STRING, allowNull: false },
      beforeSnapshot: { type: Sequelize.JSONB, allowNull: true },
      afterSnapshot: { type: Sequelize.JSONB, allowNull: true },
      ipAddress: { type: Sequelize.STRING, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('audit_logs', ['tenantId', 'entityType', 'entityId'], { name: 'audit_logs_entity_idx' });

    // --- M03: Product / BOM masters ---
    await queryInterface.createTable('uoms', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING, allowNull: false },
      code: { type: Sequelize.STRING, allowNull: false },
      status: { type: Sequelize.ENUM(...STATUS_ACTIVE_INACTIVE), defaultValue: 'active' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('uoms', ['tenantId', 'code'], { unique: true, name: 'uoms_tenant_code_unique' });

    await queryInterface.createTable('product_categories', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING, allowNull: false },
      code: { type: Sequelize.STRING, allowNull: true },
      parentId: { type: Sequelize.UUID, allowNull: true, references: { model: 'product_categories', key: 'id' }, onDelete: 'SET NULL' },
      status: { type: Sequelize.ENUM(...STATUS_ACTIVE_INACTIVE), defaultValue: 'active' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('hsn_codes', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      code: { type: Sequelize.STRING, allowNull: false },
      description: { type: Sequelize.STRING, allowNull: true },
      gstRatePercent: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
      status: { type: Sequelize.ENUM(...STATUS_ACTIVE_INACTIVE), defaultValue: 'active' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('hsn_codes', ['tenantId', 'code'], { unique: true, name: 'hsn_codes_tenant_code_unique' });

    await queryInterface.createTable('products', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      categoryId: { type: Sequelize.UUID, allowNull: true, references: { model: 'product_categories', key: 'id' }, onDelete: 'SET NULL' },
      uomId: { type: Sequelize.UUID, allowNull: false, references: { model: 'uoms', key: 'id' }, onDelete: 'RESTRICT' },
      hsnId: { type: Sequelize.UUID, allowNull: true, references: { model: 'hsn_codes', key: 'id' }, onDelete: 'SET NULL' },
      name: { type: Sequelize.STRING, allowNull: false },
      code: { type: Sequelize.STRING, allowNull: false },
      productType: { type: Sequelize.ENUM('FINISHED_GOOD', 'RAW_MATERIAL'), defaultValue: 'FINISHED_GOOD' },
      curingDays: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      standardCostPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      status: { type: Sequelize.ENUM(...STATUS_ACTIVE_INACTIVE), defaultValue: 'active' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('products', ['tenantId', 'code'], { unique: true, name: 'products_tenant_code_unique' });

    await queryInterface.createTable('mix_designs', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING, allowNull: false },
      version: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 1 },
      isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      effectiveFrom: { type: Sequelize.DATEONLY, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    // BR-06: production consumes raw materials per "the active mix design" —
    // singular. Enforced at the DB level, not just in the service layer.
    await queryInterface.addIndex('mix_designs', ['tenantId', 'productId'], {
      unique: true,
      where: { isActive: true },
      name: 'mix_designs_one_active_per_product',
    });

    await queryInterface.createTable('mix_design_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      mixDesignId: { type: Sequelize.UUID, allowNull: false, references: { model: 'mix_designs', key: 'id' }, onDelete: 'CASCADE' },
      rawMaterialProductId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      quantityPerUnit: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      uomId: { type: Sequelize.UUID, allowNull: false, references: { model: 'uoms', key: 'id' }, onDelete: 'RESTRICT' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // --- M04: Party masters (unified Customer/Vendor/Contractor/Labour/SalesRef) ---
    await queryInterface.createTable('parties', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      partyType: { type: Sequelize.ENUM('CUSTOMER', 'VENDOR', 'CONTRACTOR', 'LABOUR', 'SALES_REF'), allowNull: false },
      name: { type: Sequelize.STRING, allowNull: false },
      code: { type: Sequelize.STRING, allowNull: true },
      gstin: { type: Sequelize.STRING, allowNull: true },
      phone: { type: Sequelize.STRING, allowNull: true },
      email: { type: Sequelize.STRING, allowNull: true },
      address: { type: Sequelize.TEXT, allowNull: true },
      city: { type: Sequelize.STRING, allowNull: true },
      state: { type: Sequelize.STRING, allowNull: true },
      country: { type: Sequelize.STRING, allowNull: true, defaultValue: 'India' },
      creditLimitPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      creditAgeingDays: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      creditAction: { type: Sequelize.ENUM('NONE', 'WARN', 'BLOCK'), allowNull: false, defaultValue: 'NONE' },
      status: { type: Sequelize.ENUM(...STATUS_ACTIVE_INACTIVE), defaultValue: 'active' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('parties', ['tenantId', 'partyType'], { name: 'parties_tenant_type_idx' });

    await queryInterface.createTable('labour_wage_profiles', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      partyId: { type: Sequelize.UUID, allowNull: false, unique: true, references: { model: 'parties', key: 'id' }, onDelete: 'CASCADE' },
      dailyWagePaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      overtimeRateMultiplier: { type: Sequelize.DECIMAL(4, 2), allowNull: false, defaultValue: 1.5 },
      effectiveFrom: { type: Sequelize.DATEONLY, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // --- M05: Pricing ---
    await queryInterface.createTable('price_lists', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING, allowNull: false },
      priceType: { type: Sequelize.ENUM('RETAIL', 'WHOLESALE', 'PARTY_SPECIFIC', 'CONTRACTOR_RATE'), allowNull: false },
      partyId: { type: Sequelize.UUID, allowNull: true, references: { model: 'parties', key: 'id' }, onDelete: 'CASCADE' },
      isDefault: { type: Sequelize.BOOLEAN, defaultValue: false },
      status: { type: Sequelize.ENUM(...STATUS_ACTIVE_INACTIVE), defaultValue: 'active' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('price_list_items', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      priceListId: { type: Sequelize.UUID, allowNull: false, references: { model: 'price_lists', key: 'id' }, onDelete: 'CASCADE' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'CASCADE' },
      ratePaise: { type: Sequelize.BIGINT, allowNull: false },
      effectiveFrom: { type: Sequelize.DATEONLY, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('price_list_items', ['priceListId', 'productId'], {
      unique: true,
      name: 'price_list_items_list_product_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('price_list_items');
    await queryInterface.dropTable('price_lists');
    await queryInterface.dropTable('labour_wage_profiles');
    await queryInterface.dropTable('parties');
    await queryInterface.dropTable('mix_design_lines');
    await queryInterface.dropTable('mix_designs');
    await queryInterface.dropTable('products');
    await queryInterface.dropTable('hsn_codes');
    await queryInterface.dropTable('product_categories');
    await queryInterface.dropTable('uoms');
    await queryInterface.dropTable('audit_logs');
    await queryInterface.dropTable('document_series');
    await queryInterface.dropTable('user_factories');
    await queryInterface.dropTable('financial_years');
    await queryInterface.dropTable('factories');
  },
};
