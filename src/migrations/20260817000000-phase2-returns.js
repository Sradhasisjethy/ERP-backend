'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('sales_returns', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      returnNumber: { type: Sequelize.STRING, allowNull: false },
      salesInvoiceId: { type: Sequelize.UUID, allowNull: true, references: { model: 'sales_invoices', key: 'id' }, onDelete: 'SET NULL' },
      customerPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      returnDate: { type: Sequelize.DATEONLY, allowNull: false },
      reason: { type: Sequelize.TEXT, allowNull: false },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      totalAmountPaise: { type: Sequelize.BIGINT, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('sales_returns', ['tenantId', 'returnNumber'], { unique: true, name: 'sales_returns_tenant_number_unique' });

    await queryInterface.createTable('sales_return_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      salesReturnId: { type: Sequelize.UUID, allowNull: false, references: { model: 'sales_returns', key: 'id' }, onDelete: 'CASCADE' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      ratePaise: { type: Sequelize.BIGINT, allowNull: false },
      createdLotId: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_lots', key: 'id' }, onDelete: 'RESTRICT' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('purchase_returns', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      returnNumber: { type: Sequelize.STRING, allowNull: false },
      vendorPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      returnDate: { type: Sequelize.DATEONLY, allowNull: false },
      reason: { type: Sequelize.TEXT, allowNull: false },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      totalAmountPaise: { type: Sequelize.BIGINT, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('purchase_returns', ['tenantId', 'returnNumber'], { unique: true, name: 'purchase_returns_tenant_number_unique' });

    await queryInterface.createTable('purchase_return_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      purchaseReturnId: { type: Sequelize.UUID, allowNull: false, references: { model: 'purchase_returns', key: 'id' }, onDelete: 'CASCADE' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      ratePaise: { type: Sequelize.BIGINT, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('credit_notes', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      noteNumber: { type: Sequelize.STRING, allowNull: false },
      customerPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      salesInvoiceId: { type: Sequelize.UUID, allowNull: true, references: { model: 'sales_invoices', key: 'id' }, onDelete: 'SET NULL' },
      noteDate: { type: Sequelize.DATEONLY, allowNull: false },
      reason: { type: Sequelize.TEXT, allowNull: false },
      amountPaise: { type: Sequelize.BIGINT, allowNull: false },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('credit_notes', ['tenantId', 'noteNumber'], { unique: true, name: 'credit_notes_tenant_number_unique' });

    await queryInterface.createTable('debit_notes', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      noteNumber: { type: Sequelize.STRING, allowNull: false },
      vendorPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      noteDate: { type: Sequelize.DATEONLY, allowNull: false },
      reason: { type: Sequelize.TEXT, allowNull: false },
      amountPaise: { type: Sequelize.BIGINT, allowNull: false },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('debit_notes', ['tenantId', 'noteNumber'], { unique: true, name: 'debit_notes_tenant_number_unique' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('debit_notes');
    await queryInterface.dropTable('credit_notes');
    await queryInterface.dropTable('purchase_return_lines');
    await queryInterface.dropTable('purchase_returns');
    await queryInterface.dropTable('sales_return_lines');
    await queryInterface.dropTable('sales_returns');
  },
};
