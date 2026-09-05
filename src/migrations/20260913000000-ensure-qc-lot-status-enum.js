'use strict';

/**
 * Adds QC_HOLD and QC_FAILED to enum_stock_lots_status.
 *
 * 20260901000000-quality-control.js already contains these two ALTER TYPE
 * statements, and it is recorded as applied — but on the development database
 * the type still carries only the five original labels. That database was built
 * by `sequelize.sync()` from the models rather than by the migrations (see the
 * drift reconciled in 20260908000000), so its migration history describes
 * statements that never actually ran against it.
 *
 * The consequence was a nightly job dying every night: promoteEligibleLots
 * issues `UPDATE stock_lots SET status = 'QC_HOLD'` for any factory with
 * qcHoldEnabled, Postgres cannot cast that literal to the type, and the whole
 * promoteCuredLots run aborts — so no lot at any factory left CURING.
 *
 * Written to be safely re-runnable, and separate from the original migration
 * because that one will never run again anywhere it is already recorded.
 *
 * Not wrapped in an explicit transaction: ALTER TYPE ... ADD VALUE could not
 * run inside a transaction block before Postgres 12, and there is nothing here
 * that needs to be atomic with anything else.
 */
module.exports = {
  async up(queryInterface) {
    for (const label of ['QC_HOLD', 'QC_FAILED']) {
      await queryInterface.sequelize.query(
        `ALTER TYPE "enum_stock_lots_status" ADD VALUE IF NOT EXISTS '${label}';`
      );
    }
  },

  async down() {
    // Postgres cannot remove a value from an enum type without rebuilding it,
    // and rebuilding would require rewriting every stock_lots row plus any
    // dependent view. Nothing reads these labels unless a factory opts into
    // quality holds, so leaving them in place is harmless — the same reasoning
    // the original quality-control migration recorded.
  },
};
