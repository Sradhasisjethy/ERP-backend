'use strict';

/**
 * Two alerts the DPDP module raises from the nightly run: a data principal
 * request past the response time the business published, and a breach whose
 * 72-hour report to the Data Protection Board is due within a day or overdue.
 *
 * Not wrapped in a transaction, for the same reason as
 * 20260913000000-ensure-qc-lot-status-enum.js: ALTER TYPE ... ADD VALUE.
 * Postgres cannot drop an enum value, so `down` leaves them in place.
 */
module.exports = {
  async up(queryInterface) {
    for (const label of ['PRIVACY_REQUEST_OVERDUE', 'PRIVACY_BREACH_REPORT_DUE']) {
      await queryInterface.sequelize.query(`ALTER TYPE "enum_notifications_type" ADD VALUE IF NOT EXISTS '${label}';`);
    }
  },

  async down() {},
};
