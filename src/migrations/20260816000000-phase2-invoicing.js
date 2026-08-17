'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('sales_invoices', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      invoiceNumber: { type: Sequelize.STRING, allowNull: false },
      customerPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      invoiceDate: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      subtotalPaise: { type: Sequelize.BIGINT, allowNull: false },
      cgstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      sgstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      igstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      roundOffPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      totalPaise: { type: Sequelize.BIGINT, allowNull: false },
      cancelReason: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('sales_invoices', ['tenantId', 'invoiceNumber'], { unique: true, name: 'sales_invoices_tenant_number_unique' });

    await queryInterface.createTable('sales_invoice_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      salesInvoiceId: { type: Sequelize.UUID, allowNull: false, references: { model: 'sales_invoices', key: 'id' }, onDelete: 'CASCADE' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      hsnCode: { type: Sequelize.STRING, allowNull: true },
      quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      ratePaise: { type: Sequelize.BIGINT, allowNull: false },
      gstRatePercent: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
      taxableAmountPaise: { type: Sequelize.BIGINT, allowNull: false },
      cgstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      sgstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      igstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      lineTotalPaise: { type: Sequelize.BIGINT, allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('sales_invoice_challans', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      salesInvoiceId: { type: Sequelize.UUID, allowNull: false, references: { model: 'sales_invoices', key: 'id' }, onDelete: 'CASCADE' },
      deliveryChallanId: { type: Sequelize.UUID, allowNull: false, references: { model: 'delivery_challans', key: 'id' }, onDelete: 'RESTRICT' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    // BR-15: a challan converts to an invoice once and only once — enforced
    // at the DB level, not just in the service.
    await queryInterface.addIndex('sales_invoice_challans', ['deliveryChallanId'], { unique: true, name: 'sales_invoice_challans_challan_unique' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('sales_invoice_challans');
    await queryInterface.dropTable('sales_invoice_lines');
    await queryInterface.dropTable('sales_invoices');
  },
};
