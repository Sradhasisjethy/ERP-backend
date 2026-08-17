'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('saved_reports', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      name: { type: Sequelize.STRING, allowNull: false },
      reportType: {
        type: Sequelize.ENUM(
          'STOCK_AGEING', 'DASHBOARD_KPIS', 'COSTING', 'ALERTS', 'CANCELLATION_ANALYTICS',
          'DOCUMENT_SEARCH', 'TRIAL_BALANCE', 'PARTY_LEDGER', 'CASH_BOOK', 'GSTR1', 'GSTR3B'
        ),
        allowNull: false,
      },
      params: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('saved_reports', ['tenantId', 'name'], { name: 'saved_reports_tenant_name_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('saved_reports');
  },
};
