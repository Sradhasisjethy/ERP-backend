'use strict';

/**
 * Fixes model/migration drift on `stock_ledger_entries.updatedAt`.
 *
 * The model declares the stock ledger append-only:
 *
 *     // stockLedgerEntry.model.js
 *     updatedAt: false,
 *
 * so Sequelize never supplies a value for that column. The migration that
 * created the table nonetheless declared it `allowNull: false`. Against a
 * schema built from the migrations — which is what production runs, and what
 * tests/helpers/db.js switched the test suite to — every insert into the stock
 * ledger therefore failed with:
 *
 *     null value in column "updatedAt" of relation "stock_ledger_entries"
 *     violates not-null constraint
 *
 * That is not a reporting bug; it breaks every goods receipt, production entry,
 * dispatch and stock transfer in the system. It surfaced while building the
 * Reports module because the reporting tests need real stock movement to report
 * on, and none could be created.
 *
 * The column is made nullable rather than dropped. Dropping it would match the
 * ledger tables (journal_entries and journal_lines correctly have createdAt
 * only), but it is destructive on a deployment that already holds values, and
 * nothing reads the column either way. Nullable fixes the defect completely and
 * is reversible.
 */

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('stock_ledger_entries')) return;

    const described = await queryInterface.describeTable('stock_ledger_entries');
    if (!described.updatedAt || described.updatedAt.allowNull) return;

    await queryInterface.changeColumn('stock_ledger_entries', 'updatedAt', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('stock_ledger_entries')) return;

    // Existing rows written since this migration ran carry NULL, which the
    // restored NOT NULL would reject — backfill from createdAt first.
    await queryInterface.sequelize.query(
      'UPDATE "stock_ledger_entries" SET "updatedAt" = "createdAt" WHERE "updatedAt" IS NULL'
    );
    await queryInterface.changeColumn('stock_ledger_entries', 'updatedAt', {
      type: Sequelize.DATE,
      allowNull: false,
    });
  },
};
