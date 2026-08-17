'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // --- M06/M07: Sales Orders ---
    await queryInterface.createTable('sales_orders', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      orderNumber: { type: Sequelize.STRING, allowNull: false },
      customerPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      orderDate: { type: Sequelize.DATEONLY, allowNull: false },
      poReferenceNumber: { type: Sequelize.STRING, allowNull: true },
      poAttachmentPath: { type: Sequelize.STRING, allowNull: true },
      status: {
        type: Sequelize.ENUM('DRAFT', 'CONFIRMED', 'IN_PRODUCTION', 'PARTIALLY_DISPATCHED', 'DISPATCHED', 'SHORT_CLOSED', 'CANCELLED'),
        allowNull: false, defaultValue: 'DRAFT',
      },
      totalAmountPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      cancelReason: { type: Sequelize.TEXT, allowNull: true },
      cancelledAt: { type: Sequelize.DATE, allowNull: true },
      shortCloseReason: { type: Sequelize.TEXT, allowNull: true },
      shortClosedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('sales_orders', ['tenantId', 'orderNumber'], { unique: true, name: 'sales_orders_tenant_number_unique' });

    await queryInterface.createTable('sales_order_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      salesOrderId: { type: Sequelize.UUID, allowNull: false, references: { model: 'sales_orders', key: 'id' }, onDelete: 'CASCADE' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      orderedQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      ratePaise: { type: Sequelize.BIGINT, allowNull: false },
      dispatchedQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('sales_order_lines', ['tenantId', 'productId'], { name: 'sales_order_lines_product_idx' });

    // --- M08: Production Plan ---
    await queryInterface.createTable('production_plans', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      planDate: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('PROPOSED', 'CONFIRMED'), allowNull: false, defaultValue: 'PROPOSED' },
      notes: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('production_plan_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      productionPlanId: { type: Sequelize.UUID, allowNull: false, references: { model: 'production_plans', key: 'id' }, onDelete: 'CASCADE' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      requiredQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      confirmedQty: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // --- M09/M10: Production Entry & Material Consumption ---
    await queryInterface.createTable('production_entries', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      entryNumber: { type: Sequelize.STRING, allowNull: false },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      mixDesignId: { type: Sequelize.UUID, allowNull: false, references: { model: 'mix_designs', key: 'id' }, onDelete: 'RESTRICT' },
      productionPlanLineId: { type: Sequelize.UUID, allowNull: true, references: { model: 'production_plan_lines', key: 'id' }, onDelete: 'SET NULL' },
      productionDate: { type: Sequelize.DATEONLY, allowNull: false },
      goodQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      rejectedQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },
      curingDays: { type: Sequelize.INTEGER, allowNull: false },
      lotId: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_lots', key: 'id' }, onDelete: 'RESTRICT' },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      cancelReason: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('production_entries', ['tenantId', 'entryNumber'], { unique: true, name: 'production_entries_tenant_number_unique' });

    await queryInterface.createTable('material_consumptions', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      productionEntryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'production_entries', key: 'id' }, onDelete: 'CASCADE' },
      rawMaterialProductId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      mixDesignQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      actualQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      variancePercent: { type: Sequelize.DECIMAL(6, 2), allowNull: false, defaultValue: 0 },
      varianceReason: { type: Sequelize.TEXT, allowNull: true },
      requiresApproval: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      approvedBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
      approvedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('material_consumptions', ['tenantId', 'requiresApproval', 'approvedBy'], { name: 'material_consumptions_pending_approval_idx' });

    // --- M11: Wastage ---
    await queryInterface.createTable('wastage_records', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      lotId: { type: Sequelize.UUID, allowNull: true, references: { model: 'stock_lots', key: 'id' }, onDelete: 'SET NULL' },
      productionEntryId: { type: Sequelize.UUID, allowNull: true, references: { model: 'production_entries', key: 'id' }, onDelete: 'SET NULL' },
      stage: { type: Sequelize.ENUM('DEMOULDING', 'STACKING', 'HANDLING', 'TRANSIT'), allowNull: false },
      quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      reason: { type: Sequelize.TEXT, allowNull: false },
      recordedDate: { type: Sequelize.DATEONLY, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('wastage_records');
    await queryInterface.dropTable('material_consumptions');
    await queryInterface.dropTable('production_entries');
    await queryInterface.dropTable('production_plan_lines');
    await queryInterface.dropTable('production_plans');
    await queryInterface.dropTable('sales_order_lines');
    await queryInterface.dropTable('sales_orders');
  },
};
