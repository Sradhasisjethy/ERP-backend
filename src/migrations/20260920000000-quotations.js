'use strict';

/**
 * Quotations: a priced offer to a customer or a prospect, which becomes a
 * sales order when accepted. New tables only.
 *
 * A quotation may be for someone who is not yet a customer (a contractor
 * asking for a rate on 200 metres of pipe), so the prospect's name, phone and
 * state are held on the quotation itself and a party is only created if the
 * quote is converted.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('quotations')) {
      await queryInterface.createTable('quotations', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
        quotationNumber: { type: Sequelize.STRING, allowNull: false },
        quotationDate: { type: Sequelize.DATEONLY, allowNull: false },
        validUntil: { type: Sequelize.DATEONLY, allowNull: false },
        customerPartyId: { type: Sequelize.UUID, allowNull: true, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
        prospectName: { type: Sequelize.STRING(160), allowNull: true },
        prospectPhone: { type: Sequelize.STRING(20), allowNull: true },
        prospectState: { type: Sequelize.STRING(60), allowNull: true },
        prospectGstin: { type: Sequelize.STRING(15), allowNull: true },
        status: {
          type: Sequelize.ENUM('DRAFT', 'SENT', 'ACCEPTED', 'REJECTED', 'CONVERTED', 'CANCELLED'),
          allowNull: false,
          defaultValue: 'DRAFT',
        },
        discountPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        subtotalPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        cgstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        sgstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        igstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        roundOffPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        totalPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        notes: { type: Sequelize.TEXT, allowNull: true },
        terms: { type: Sequelize.TEXT, allowNull: true },
        statusReason: { type: Sequelize.TEXT, allowNull: true },
        salesOrderId: { type: Sequelize.UUID, allowNull: true, references: { model: 'sales_orders', key: 'id' }, onDelete: 'SET NULL' },
        convertedAt: { type: Sequelize.DATE, allowNull: true },
        createdBy: { type: Sequelize.UUID, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('quotations', ['tenantId', 'quotationNumber'], { unique: true, name: 'quotations_tenant_number_unique' });
      await queryInterface.addIndex('quotations', ['tenantId', 'factoryId', 'quotationDate'], { name: 'quotations_tenant_factory_date' });
    }

    if (!tables.includes('quotation_lines')) {
      await queryInterface.createTable('quotation_lines', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        quotationId: { type: Sequelize.UUID, allowNull: false, references: { model: 'quotations', key: 'id' }, onDelete: 'CASCADE' },
        productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
        // Set on accessories a bundle rule added, naming the product that
        // brought them. A converted order adds these itself, so they are not
        // sent as lines of their own.
        bundleParentProductId: { type: Sequelize.UUID, allowNull: true },
        hsnCode: { type: Sequelize.STRING(20), allowNull: true },
        quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
        ratePaise: { type: Sequelize.BIGINT, allowNull: false },
        discountPercent: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
        discountPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        taxableAmountPaise: { type: Sequelize.BIGINT, allowNull: false },
        gstRatePercent: { type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
        cgstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        sgstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        igstPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        lineTotalPaise: { type: Sequelize.BIGINT, allowNull: false },
        sortOrder: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('quotation_lines', ['quotationId'], { name: 'quotation_lines_quotation' });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('quotation_lines').catch(() => {});
    await queryInterface.dropTable('quotations').catch(() => {});
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_quotations_status";');
  },
};
