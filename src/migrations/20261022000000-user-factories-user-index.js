'use strict';

/**
 * BR-29 factory scope is resolved on every authenticated request with
 * `SELECT "factoryId" FROM user_factories WHERE "userId" = ?`. The table's only
 * index is the unique (factoryId, userId) pair, which Postgres cannot use for a
 * userId-only lookup, so the hottest access-control query in the product was a
 * sequential scan. Harmless at ten rows; not at ten thousand.
 *
 * IF NOT EXISTS because the dev database predates migrations (it was built by
 * sync()) and may or may not already carry the index.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'CREATE INDEX IF NOT EXISTS user_factories_user_idx ON public.user_factories USING btree ("userId");'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS user_factories_user_idx;');
  },
};
