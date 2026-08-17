'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('expenses', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      expenseNumber: { type: Sequelize.STRING, allowNull: false },
      expenseDate: { type: Sequelize.DATEONLY, allowNull: false },
      category: { type: Sequelize.STRING, allowNull: false },
      mode: { type: Sequelize.ENUM('CASH', 'BANK'), allowNull: false },
      amountPaise: { type: Sequelize.BIGINT, allowNull: false },
      paidToPartyId: { type: Sequelize.UUID, allowNull: true, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      description: { type: Sequelize.TEXT, allowNull: true },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('expenses', ['tenantId', 'expenseNumber'], { unique: true, name: 'expenses_tenant_number_unique' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('expenses');
  },
};
