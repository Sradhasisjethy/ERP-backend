'use strict';

/**
 * Fixed asset register and depreciation runs.
 *
 * Moulds, batching plants, cranes and trucks are a precast plant's largest
 * assets and were nowhere in the books. An asset is registered once (posting
 * its cost to Fixed Assets), depreciated by periodic runs (Depreciation /
 * Accumulated Depreciation), and eventually disposed of.
 *
 * New tables only; nothing existing changes.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('fixed_assets')) {
      await queryInterface.createTable('fixed_assets', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
        assetNumber: { type: Sequelize.STRING, allowNull: false },
        name: { type: Sequelize.STRING(160), allowNull: false },
        category: { type: Sequelize.STRING(80), allowNull: false },
        serialNumber: { type: Sequelize.STRING(80), allowNull: true },
        description: { type: Sequelize.TEXT, allowNull: true },
        // How it came onto the books: bought now (paid from cash/bank) or
        // already owned at go-live (against Opening Balance Equity).
        acquisitionType: { type: Sequelize.ENUM('PURCHASED', 'EXISTING'), allowNull: false },
        paidFromAccountId: { type: Sequelize.UUID, allowNull: true, references: { model: 'accounts', key: 'id' }, onDelete: 'RESTRICT' },
        vendorPartyId: { type: Sequelize.UUID, allowNull: true, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
        acquisitionDate: { type: Sequelize.DATEONLY, allowNull: false },
        // Depreciation starts here, not at purchase: a mould bought in March
        // and first cast in May starts wearing in May.
        putToUseDate: { type: Sequelize.DATEONLY, allowNull: false },
        costPaise: { type: Sequelize.BIGINT, allowNull: false },
        salvageValuePaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        method: { type: Sequelize.ENUM('SLM', 'WDV'), allowNull: false },
        usefulLifeMonths: { type: Sequelize.INTEGER, allowNull: true },
        ratePercent: { type: Sequelize.DECIMAL(6, 2), allowNull: true },
        accumulatedDepreciationPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
        // The last day depreciation has been charged for. NULL until the first run.
        depreciatedUpTo: { type: Sequelize.DATEONLY, allowNull: true },
        status: { type: Sequelize.ENUM('ACTIVE', 'DISPOSED'), allowNull: false, defaultValue: 'ACTIVE' },
        disposedOn: { type: Sequelize.DATEONLY, allowNull: true },
        disposalProceedsPaise: { type: Sequelize.BIGINT, allowNull: true },
        disposalNote: { type: Sequelize.TEXT, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('fixed_assets', ['tenantId', 'assetNumber'], { unique: true, name: 'fixed_assets_tenant_number_unique' });
      await queryInterface.addIndex('fixed_assets', ['tenantId', 'factoryId', 'status'], { name: 'fixed_assets_tenant_factory_status' });
    }

    if (!tables.includes('depreciation_runs')) {
      await queryInterface.createTable('depreciation_runs', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
        runNumber: { type: Sequelize.STRING, allowNull: false },
        upToDate: { type: Sequelize.DATEONLY, allowNull: false },
        totalPaise: { type: Sequelize.BIGINT, allowNull: false },
        // [{ assetId, amountPaise, fromDate, previousUpTo }] — what cancelling
        // needs to put every asset back exactly as it was.
        lines: { type: Sequelize.JSONB, allowNull: false },
        status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
        cancelReason: { type: Sequelize.TEXT, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('depreciation_runs', ['tenantId', 'runNumber'], { unique: true, name: 'depreciation_runs_tenant_number_unique' });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('depreciation_runs').catch(() => {});
    await queryInterface.dropTable('fixed_assets').catch(() => {});
    for (const type of [
      'enum_depreciation_runs_status', 'enum_fixed_assets_status', 'enum_fixed_assets_method', 'enum_fixed_assets_acquisitionType',
    ]) {
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${type}";`);
    }
  },
};
