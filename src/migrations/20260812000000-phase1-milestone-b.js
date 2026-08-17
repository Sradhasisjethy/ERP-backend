'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    // --- Inventory core (BR-01..BR-05, M13) ---
    await queryInterface.createTable('stock_lots', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      lotNumber: { type: Sequelize.STRING, allowNull: false },
      originType: { type: Sequelize.ENUM('PRODUCTION', 'PURCHASE', 'TRANSFER_IN'), allowNull: false },
      originId: { type: Sequelize.UUID, allowNull: false },
      originDate: { type: Sequelize.DATEONLY, allowNull: false },
      curingDays: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      status: { type: Sequelize.ENUM('CURING', 'AVAILABLE', 'WITH_CONTRACTOR', 'IN_TRANSIT', 'CONSUMED'), allowNull: false, defaultValue: 'AVAILABLE' },
      qtyOriginal: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      qtyAvailable: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('stock_lots', ['tenantId', 'factoryId', 'productId', 'status'], { name: 'stock_lots_factory_product_status_idx' });
    await queryInterface.addIndex('stock_lots', ['tenantId', 'lotNumber'], { unique: true, name: 'stock_lots_tenant_number_unique' });

    await queryInterface.createTable('stock_ledger_entries', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      lotId: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_lots', key: 'id' }, onDelete: 'RESTRICT' },
      movementType: {
        type: Sequelize.ENUM('PRODUCTION_IN', 'PRODUCTION_OUT', 'PURCHASE_IN', 'TRANSFER_OUT', 'TRANSFER_IN', 'SALE_OUT', 'BREAKAGE_OUT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT', 'REVERSAL'),
        allowNull: false,
      },
      direction: { type: Sequelize.ENUM('IN', 'OUT'), allowNull: false },
      quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      referenceType: { type: Sequelize.STRING, allowNull: false },
      referenceId: { type: Sequelize.UUID, allowNull: false },
      reversalOfEntryId: { type: Sequelize.UUID, allowNull: true, references: { model: 'stock_ledger_entries', key: 'id' }, onDelete: 'SET NULL' },
      isNegativeStockEvent: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      notes: { type: Sequelize.TEXT, allowNull: true },
      createdBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('stock_ledger_entries', ['tenantId', 'lotId'], { name: 'stock_ledger_entries_lot_idx' });
    await queryInterface.addIndex('stock_ledger_entries', ['tenantId', 'referenceType', 'referenceId'], { name: 'stock_ledger_entries_reference_idx' });

    // --- M12: Purchasing ---
    await queryInterface.createTable('purchase_orders', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      poNumber: { type: Sequelize.STRING, allowNull: false },
      vendorPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      orderDate: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('DRAFT', 'CONFIRMED', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'), allowNull: false, defaultValue: 'DRAFT' },
      totalAmountPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      cancelReason: { type: Sequelize.TEXT, allowNull: true },
      cancelledAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('purchase_orders', ['tenantId', 'poNumber'], { unique: true, name: 'purchase_orders_tenant_number_unique' });

    await queryInterface.createTable('purchase_order_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      purchaseOrderId: { type: Sequelize.UUID, allowNull: false, references: { model: 'purchase_orders', key: 'id' }, onDelete: 'CASCADE' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      orderedQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      ratePaise: { type: Sequelize.BIGINT, allowNull: false },
      receivedQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('goods_receipts', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      grnNumber: { type: Sequelize.STRING, allowNull: false },
      purchaseOrderId: { type: Sequelize.UUID, allowNull: true, references: { model: 'purchase_orders', key: 'id' }, onDelete: 'SET NULL' },
      vendorPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      receiptDate: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      cancelReason: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('goods_receipts', ['tenantId', 'grnNumber'], { unique: true, name: 'goods_receipts_tenant_number_unique' });

    await queryInterface.createTable('goods_receipt_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      goodsReceiptId: { type: Sequelize.UUID, allowNull: false, references: { model: 'goods_receipts', key: 'id' }, onDelete: 'CASCADE' },
      purchaseOrderLineId: { type: Sequelize.UUID, allowNull: true, references: { model: 'purchase_order_lines', key: 'id' }, onDelete: 'SET NULL' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      receivedQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      ratePaise: { type: Sequelize.BIGINT, allowNull: false },
      lotId: { type: Sequelize.UUID, allowNull: true, references: { model: 'stock_lots', key: 'id' }, onDelete: 'SET NULL' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('purchase_invoices', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      goodsReceiptId: { type: Sequelize.UUID, allowNull: false, references: { model: 'goods_receipts', key: 'id' }, onDelete: 'RESTRICT' },
      vendorPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      vendorInvoiceNumber: { type: Sequelize.STRING, allowNull: false },
      invoiceDate: { type: Sequelize.DATEONLY, allowNull: false },
      dueDate: { type: Sequelize.DATEONLY, allowNull: true },
      amountPaise: { type: Sequelize.BIGINT, allowNull: false },
      paymentStatus: { type: Sequelize.ENUM('UNPAID', 'PARTIALLY_PAID', 'PAID'), allowNull: false, defaultValue: 'UNPAID' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // --- M14: Inter-factory transfer, incl. in-transit ---
    await queryInterface.createTable('stock_transfers', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      fromFactoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      toFactoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      transferNumber: { type: Sequelize.STRING, allowNull: false },
      vehicleNumber: { type: Sequelize.STRING, allowNull: true },
      initiatedDate: { type: Sequelize.DATEONLY, allowNull: false },
      receivedDate: { type: Sequelize.DATEONLY, allowNull: true },
      status: { type: Sequelize.ENUM('IN_TRANSIT', 'RECEIVED', 'CANCELLED'), allowNull: false, defaultValue: 'IN_TRANSIT' },
      cancelReason: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('stock_transfers', ['tenantId', 'transferNumber'], { unique: true, name: 'stock_transfers_tenant_number_unique' });

    await queryInterface.createTable('stock_transfer_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      stockTransferId: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_transfers', key: 'id' }, onDelete: 'CASCADE' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      sourceLotId: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_lots', key: 'id' }, onDelete: 'RESTRICT' },
      quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      receivedQuantity: { type: Sequelize.DECIMAL(14, 4), allowNull: true },
      destinationLotId: { type: Sequelize.UUID, allowNull: true, references: { model: 'stock_lots', key: 'id' }, onDelete: 'SET NULL' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('stock_transfer_lines');
    await queryInterface.dropTable('stock_transfers');
    await queryInterface.dropTable('purchase_invoices');
    await queryInterface.dropTable('goods_receipt_lines');
    await queryInterface.dropTable('goods_receipts');
    await queryInterface.dropTable('purchase_order_lines');
    await queryInterface.dropTable('purchase_orders');
    await queryInterface.dropTable('stock_ledger_entries');
    await queryInterface.dropTable('stock_lots');
  },
};
