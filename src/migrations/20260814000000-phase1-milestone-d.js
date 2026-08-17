'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('delivery_challans', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      challanNumber: { type: Sequelize.STRING, allowNull: false },
      salesOrderId: { type: Sequelize.UUID, allowNull: false, references: { model: 'sales_orders', key: 'id' }, onDelete: 'RESTRICT' },
      vehicleNumber: { type: Sequelize.STRING, allowNull: false },
      driverName: { type: Sequelize.STRING, allowNull: true },
      dispatchDate: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('DISPATCHED', 'CANCELLED'), allowNull: false, defaultValue: 'DISPATCHED' },
      cancelReason: { type: Sequelize.TEXT, allowNull: true },
      invoiced: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      invoicedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('delivery_challans', ['tenantId', 'challanNumber'], { unique: true, name: 'delivery_challans_tenant_number_unique' });

    await queryInterface.createTable('delivery_challan_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      deliveryChallanId: { type: Sequelize.UUID, allowNull: false, references: { model: 'delivery_challans', key: 'id' }, onDelete: 'CASCADE' },
      salesOrderLineId: { type: Sequelize.UUID, allowNull: false, references: { model: 'sales_order_lines', key: 'id' }, onDelete: 'RESTRICT' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      dispatchedQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('delivery_challan_lines');
    await queryInterface.dropTable('delivery_challans');
  },
};
