'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('receipts', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      receiptNumber: { type: Sequelize.STRING, allowNull: false },
      customerPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      receiptDate: { type: Sequelize.DATEONLY, allowNull: false },
      modes: { type: Sequelize.JSONB, allowNull: false },
      totalAmountPaise: { type: Sequelize.BIGINT, allowNull: false },
      unallocatedAmountPaise: { type: Sequelize.BIGINT, allowNull: false },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('receipts', ['tenantId', 'receiptNumber'], { unique: true, name: 'receipts_tenant_number_unique' });

    await queryInterface.createTable('payments', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      paymentNumber: { type: Sequelize.STRING, allowNull: false },
      partyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      paymentDate: { type: Sequelize.DATEONLY, allowNull: false },
      modes: { type: Sequelize.JSONB, allowNull: false },
      totalAmountPaise: { type: Sequelize.BIGINT, allowNull: false },
      unallocatedAmountPaise: { type: Sequelize.BIGINT, allowNull: false },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('payments', ['tenantId', 'paymentNumber'], { unique: true, name: 'payments_tenant_number_unique' });

    await queryInterface.createTable('payment_allocations', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      receiptId: { type: Sequelize.UUID, allowNull: true, references: { model: 'receipts', key: 'id' }, onDelete: 'CASCADE' },
      paymentId: { type: Sequelize.UUID, allowNull: true, references: { model: 'payments', key: 'id' }, onDelete: 'CASCADE' },
      invoiceType: { type: Sequelize.ENUM('SALES', 'PURCHASE'), allowNull: false },
      invoiceId: { type: Sequelize.UUID, allowNull: false },
      allocatedAmountPaise: { type: Sequelize.BIGINT, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('payment_allocations', ['tenantId', 'invoiceType', 'invoiceId'], { name: 'payment_allocations_invoice_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('payment_allocations');
    await queryInterface.dropTable('payments');
    await queryInterface.dropTable('receipts');
  },
};
