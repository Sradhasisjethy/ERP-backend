'use strict';

/**
 * The record of every master-data file that was uploaded.
 *
 * `payload` holds the validated rows between the validate call and the commit
 * call, so the commit names a run id rather than resending rows the server
 * would have to trust. It also backs the error-workbook download, which is why
 * it survives the commit instead of being cleared.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('master_import_runs', {
      id: { type: Sequelize.UUID, primaryKey: true, defaultValue: Sequelize.UUIDV4 },
      tenantId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      module: { type: Sequelize.STRING(64), allowNull: false },
      fileName: { type: Sequelize.STRING(255), allowNull: true },
      importMode: { type: Sequelize.STRING(16), allowNull: false, defaultValue: 'UPSERT' },
      status: {
        type: Sequelize.ENUM('VALIDATED', 'COMMITTED', 'FAILED', 'EXPIRED'),
        allowNull: false,
        defaultValue: 'VALIDATED',
      },
      totalRows: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      validRows: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      newRows: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      updateRows: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      errorRows: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      createdCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      updatedCount: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      payload: { type: Sequelize.JSONB, allowNull: true },
      context: { type: Sequelize.JSONB, allowNull: true },
      warnings: { type: Sequelize.JSONB, allowNull: true },
      errorMessage: { type: Sequelize.TEXT, allowNull: true },
      durationMs: { type: Sequelize.INTEGER, allowNull: true },
      userId: { type: Sequelize.UUID, allowNull: true },
      committedAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
      updatedAt: { type: Sequelize.DATE, allowNull: false, defaultValue: Sequelize.literal('CURRENT_TIMESTAMP') },
    });

    await queryInterface.addIndex('master_import_runs', ['tenantId', 'module', 'createdAt'], {
      name: 'master_import_runs_tenant_module_created',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('master_import_runs');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_master_import_runs_status";');
  },
};
