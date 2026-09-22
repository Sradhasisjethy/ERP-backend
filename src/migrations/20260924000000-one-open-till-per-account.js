'use strict';

/**
 * One open session per till, enforced by the database.
 *
 * The service already refuses to open a second session while one is open, but
 * that is a read followed by a write: two people pressing "Open till" at the
 * same moment both read "nothing open" and both insert. A partial unique index
 * makes the second insert fail no matter how the two requests interleave, and
 * costs nothing because it indexes only the handful of open rows.
 *
 * COALESCE, because the system Cash-in-Hand till stores accountId NULL and
 * NULLs do not collide in a unique index.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS cash_sessions_one_open_per_till
      ON cash_register_sessions ("tenantId", "factoryId", COALESCE("accountId", '00000000-0000-0000-0000-000000000000'::uuid))
      WHERE status = 'OPEN';
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS cash_sessions_one_open_per_till;');
  },
};
