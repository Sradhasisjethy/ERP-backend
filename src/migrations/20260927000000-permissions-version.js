'use strict';

/**
 * Makes a revoked permission take effect now, instead of within the hour.
 *
 * Permissions are resolved at login and baked into the access token, and
 * `authenticate` verified that token's signature and nothing else — no database
 * lookup, no denylist. So removing a permission from a role, taking a user out
 * of a role, deactivating a role or demoting a user's system role all changed
 * nothing until the token expired. `JWT_ACCESS_EXPIRATION` defaults to **1 hour**
 * (several comments in the codebase say fifteen minutes and are simply wrong),
 * and there was no way to shorten it for a specific user: `revokeRefreshTokens`
 * only touches the refresh table, so a live access token outlived any attempt to
 * cut the session short.
 *
 * The counter is the smallest thing that closes it. It goes into the token as a
 * claim; `authenticate` compares the claim against this column and rejects a
 * token minted before the last permission change. Anything that alters what a
 * user may do bumps it (see PermissionVersionService), so revocation is
 * immediate and precise — one user's counter moving does not log anybody else
 * out.
 *
 * Defaults to 1 rather than 0 so that an existing token, which carries no claim
 * at all, is treated as stale and re-minted on its next refresh rather than
 * silently accepted forever.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const described = await queryInterface.describeTable('employees');
    if (described.permissionsVersion) return;

    await queryInterface.addColumn('employees', 'permissionsVersion', {
      type: Sequelize.INTEGER,
      allowNull: false,
      defaultValue: 1,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('employees', 'permissionsVersion').catch(() => {});
  },
};
