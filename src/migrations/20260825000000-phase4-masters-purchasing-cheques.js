'use strict';

const addColumnIfMissing = async (queryInterface, table, column, spec) => {
  const described = await queryInterface.describeTable(table);
  if (!described[column]) await queryInterface.addColumn(table, column, spec);
};

const createTableIfMissing = async (queryInterface, name, definition) => {
  const tables = await queryInterface.showAllTables();
  if (!tables.includes(name)) await queryInterface.createTable(name, definition);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    // --- FR-M03-2: UoM conversions ---
    await createTableIfMissing(queryInterface, 'uom_conversions', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      fromUomId: { type: Sequelize.UUID, allowNull: false, references: { model: 'uoms', key: 'id' }, onDelete: 'RESTRICT' },
      toUomId: { type: Sequelize.UUID, allowNull: false, references: { model: 'uoms', key: 'id' }, onDelete: 'RESTRICT' },
      // 8dp, not the 4dp used for quantities: a factor is multiplied through a
      // whole BOM explosion, so rounding it early compounds the error.
      factor: { type: Sequelize.DECIMAL(18, 8), allowNull: false },
      status: { type: Sequelize.ENUM('active', 'inactive'), defaultValue: 'active' },
      lockVersion: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // --- FR-M04-2: party addresses (state code drives GST place of supply) ---
    await createTableIfMissing(queryInterface, 'party_addresses', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      partyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'CASCADE' },
      label: { type: Sequelize.STRING, allowNull: false, defaultValue: 'Main' },
      contactPerson: { type: Sequelize.STRING, allowNull: true },
      phone: { type: Sequelize.STRING, allowNull: true },
      line1: { type: Sequelize.STRING, allowNull: false },
      line2: { type: Sequelize.STRING, allowNull: true },
      city: { type: Sequelize.STRING, allowNull: true },
      state: { type: Sequelize.STRING, allowNull: true },
      stateCode: { type: Sequelize.STRING(2), allowNull: true },
      pincode: { type: Sequelize.STRING, allowNull: true },
      country: { type: Sequelize.STRING, allowNull: true, defaultValue: 'India' },
      gstin: { type: Sequelize.STRING, allowNull: true },
      isBilling: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      isShipping: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
      isDefaultBilling: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      isDefaultShipping: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      status: { type: Sequelize.ENUM('active', 'inactive'), defaultValue: 'active' },
      lockVersion: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // --- FR-M11-1: purchase indents ---
    await createTableIfMissing(queryInterface, 'purchase_indents', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      indentNumber: { type: Sequelize.STRING, allowNull: false },
      indentDate: { type: Sequelize.DATEONLY, allowNull: false },
      requiredByDate: { type: Sequelize.DATEONLY, allowNull: true },
      status: {
        type: Sequelize.ENUM('DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'REJECTED', 'CONVERTED', 'CANCELLED'),
        allowNull: false, defaultValue: 'DRAFT',
      },
      remarks: { type: Sequelize.TEXT, allowNull: true },
      approvedBy: { type: Sequelize.UUID, allowNull: true },
      approvedAt: { type: Sequelize.DATE, allowNull: true },
      rejectionReason: { type: Sequelize.TEXT, allowNull: true },
      purchaseOrderId: { type: Sequelize.UUID, allowNull: true },
      lockVersion: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await createTableIfMissing(queryInterface, 'purchase_indent_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      purchaseIndentId: { type: Sequelize.UUID, allowNull: false, references: { model: 'purchase_indents', key: 'id' }, onDelete: 'CASCADE' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      remarks: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // --- FR-M18-7: cheque lifecycle ---
    await createTableIfMissing(queryInterface, 'cheques', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      direction: { type: Sequelize.ENUM('INBOUND', 'OUTBOUND'), allowNull: false },
      partyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      chequeNumber: { type: Sequelize.STRING, allowNull: false },
      bankName: { type: Sequelize.STRING, allowNull: true },
      chequeDate: { type: Sequelize.DATEONLY, allowNull: false },
      amountPaise: { type: Sequelize.BIGINT, allowNull: false },
      status: {
        type: Sequelize.ENUM('ISSUED', 'PRESENTED', 'CLEARED', 'BOUNCED', 'CANCELLED'),
        allowNull: false, defaultValue: 'ISSUED',
      },
      presentedAt: { type: Sequelize.DATE, allowNull: true },
      clearedAt: { type: Sequelize.DATE, allowNull: true },
      bouncedAt: { type: Sequelize.DATE, allowNull: true },
      bounceReason: { type: Sequelize.TEXT, allowNull: true },
      bankChargesPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      receiptId: { type: Sequelize.UUID, allowNull: true },
      paymentId: { type: Sequelize.UUID, allowNull: true },
      lockVersion: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // --- FR-M03-6..9: BOM version lifecycle ---
    await addColumnIfMissing(queryInterface, 'mix_designs', 'status', {
      type: Sequelize.ENUM('DRAFT', 'ACTIVE', 'SUPERSEDED'), allowNull: false, defaultValue: 'DRAFT',
    });
    await addColumnIfMissing(queryInterface, 'mix_designs', 'supersededAt', { type: Sequelize.DATE, allowNull: true });
    await addColumnIfMissing(queryInterface, 'mix_designs', 'supersededByMixDesignId', { type: Sequelize.UUID, allowNull: true });
    await addColumnIfMissing(queryInterface, 'mix_designs', 'outputQuantity', {
      type: Sequelize.DECIMAL(14, 4), allowNull: false, defaultValue: 1,
    });
    await addColumnIfMissing(queryInterface, 'mix_designs', 'bomType', {
      type: Sequelize.ENUM('MANUFACTURING', 'ASSEMBLY'), allowNull: false, defaultValue: 'MANUFACTURING',
    });
    await addColumnIfMissing(queryInterface, 'mix_design_lines', 'wastagePercent', {
      type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0,
    });
    await addColumnIfMissing(queryInterface, 'mix_design_lines', 'isOptional', {
      type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false,
    });

    // Backfill: rows created before the lifecycle existed carry isActive only.
    // Without this they would all read as DRAFT and stop resolving for
    // production, which would silently break every existing product.
    await queryInterface.sequelize.query(
      `UPDATE "mix_designs" SET "status" = 'ACTIVE' WHERE "isActive" = true AND "status" = 'DRAFT'`
    );

    // --- FR-M16-2: place of supply snapshotted on the invoice ---
    await addColumnIfMissing(queryInterface, 'sales_invoices', 'placeOfSupplyCode', { type: Sequelize.STRING(2), allowNull: true });
    await addColumnIfMissing(queryInterface, 'sales_invoices', 'supplierStateCode', { type: Sequelize.STRING(2), allowNull: true });
    await addColumnIfMissing(queryInterface, 'sales_invoices', 'shippingAddressId', { type: Sequelize.UUID, allowNull: true });

    // --- D2: optimistic locking on the records humans edit through forms ---
    for (const table of [
      'parties', 'products', 'product_categories', 'uoms', 'hsn_codes',
      'price_lists', 'price_list_items', 'factories', 'organizations',
      'sales_orders', 'purchase_orders',
    ]) {
      await addColumnIfMissing(queryInterface, table, 'lockVersion', {
        type: Sequelize.INTEGER, allowNull: false, defaultValue: 0,
      });
    }
  },

  async down(queryInterface) {
    for (const table of [
      'parties', 'products', 'product_categories', 'uoms', 'hsn_codes',
      'price_lists', 'price_list_items', 'factories', 'organizations',
      'sales_orders', 'purchase_orders',
    ]) {
      await queryInterface.removeColumn(table, 'lockVersion');
    }
    for (const col of ['placeOfSupplyCode', 'supplierStateCode', 'shippingAddressId']) {
      await queryInterface.removeColumn('sales_invoices', col);
    }
    await queryInterface.removeColumn('mix_design_lines', 'isOptional');
    await queryInterface.removeColumn('mix_design_lines', 'wastagePercent');
    for (const col of ['status', 'supersededAt', 'supersededByMixDesignId', 'outputQuantity', 'bomType']) {
      await queryInterface.removeColumn('mix_designs', col);
    }
    await queryInterface.dropTable('cheques');
    await queryInterface.dropTable('purchase_indent_lines');
    await queryInterface.dropTable('purchase_indents');
    await queryInterface.dropTable('party_addresses');
    await queryInterface.dropTable('uom_conversions');
  },
};
