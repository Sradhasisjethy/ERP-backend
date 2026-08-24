'use strict';

/**
 * Adds the stock adjustment document.
 *
 * `ADJUSTMENT_IN` and `ADJUSTMENT_OUT` have been in the stock ledger's
 * movementType enum since the ledger was created, they appear in the report
 * filter vocabulary, and there is a whole "Stock Adjustments" report built on
 * them — but the only code that ever wrote one was the one-time opening-balance
 * importer. There was no API, no service and no screen to record one.
 *
 * The practical consequence for a warehouse: a physical count that disagrees
 * with the system could not be corrected. Counting 92 where the system says 100
 * left the eight units on the books permanently, because every other movement
 * type requires a business document (a receipt, a dispatch, a production entry)
 * that did not happen. The Stock Reconciliation report says as much in its own
 * `limitations`: "there is no physical stock-count entity in this schema".
 *
 * The document is deliberately a record *of* the correction, not the correction
 * itself — the actual stock change is a normal ledger entry posted through
 * StockLedgerService.postEntry, so adjustments obey exactly the same locking,
 * negative-stock and reconciliation rules as every other movement. The row
 * stores the before/after quantities and the reason so the ledger entry can
 * always be explained.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('stock_adjustments')) return;

    await queryInterface.createTable('stock_adjustments', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      lotId: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_lots', key: 'id' }, onDelete: 'RESTRICT' },
      adjustmentNumber: { type: Sequelize.STRING, allowNull: false },
      adjustmentDate: { type: Sequelize.DATEONLY, allowNull: false },

      // The four figures an auditor asks for, stored rather than recomputed:
      // what the system said, what was counted, the difference, and the result.
      previousQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      countedQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      adjustmentQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      newQty: { type: Sequelize.DECIMAL(14, 4), allowNull: false },

      reason: { type: Sequelize.TEXT, allowNull: false },
      // The movement this document explains.
      stockLedgerEntryId: { type: Sequelize.UUID, allowNull: true, references: { model: 'stock_ledger_entries', key: 'id' }, onDelete: 'RESTRICT' },
      createdBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('stock_adjustments', ['tenantId', 'adjustmentNumber'], {
      unique: true,
      name: 'stock_adjustments_tenant_number_unique',
    });
    await queryInterface.addIndex('stock_adjustments', ['tenantId', 'factoryId', 'adjustmentDate'], {
      name: 'stock_adjustments_tenant_factory_date_idx',
    });
    await queryInterface.addIndex('stock_adjustments', ['tenantId', 'productId'], {
      name: 'stock_adjustments_tenant_product_idx',
    });
    await queryInterface.addIndex('stock_adjustments', ['tenantId', 'lotId'], {
      name: 'stock_adjustments_tenant_lot_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('stock_adjustments').catch(() => {});
  },
};
