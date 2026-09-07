'use strict';

/**
 * Makes a refresh token revocable.
 *
 * Until now a refresh token was a bare signed JWT: valid for seven days,
 * accepted by anyone holding it, and impossible to withdraw. Logging out only
 * cleared the browser's cookies — the token itself kept working, so a copied
 * token outlived the session that created it, a password reset did not end
 * anything, and disabling an account only took effect at the next refresh.
 *
 * The fix is the ordinary one: each refresh token carries a `jti`, and this
 * table is the allowlist. A token is accepted only while its row exists and is
 * unrevoked, which makes logout, password reset and account suspension able to
 * end a session for real.
 *
 * Revoked rather than deleted, and carrying `replacedBy`, so a rotation chain
 * can be followed afterwards — a revoked token being presented again is the
 * signature of a stolen one, not of ordinary use.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('refresh_tokens', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      userId: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' }, onDelete: 'CASCADE' },

      // The token's own id. Only the id is stored — never the token itself, so
      // this table leaks nothing if it is read.
      jti: { type: Sequelize.UUID, allowNull: false },

      expiresAt: { type: Sequelize.DATE, allowNull: false },
      revokedAt: { type: Sequelize.DATE, allowNull: true },
      // Why it ended, for anyone reading the trail later.
      revokedReason: { type: Sequelize.STRING(50), allowNull: true },
      replacedBy: { type: Sequelize.UUID, allowNull: true },

      // Enough to tell one device from another in a session list.
      userAgent: { type: Sequelize.STRING(300), allowNull: true },
      ipAddress: { type: Sequelize.STRING(64), allowNull: true },

      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // Every refresh is a lookup by jti, so it has to be unique and indexed.
    await queryInterface.addIndex('refresh_tokens', ['jti'], {
      unique: true,
      name: 'refresh_tokens_jti_unique',
    });
    // "End every session for this user" — password reset, suspension.
    await queryInterface.addIndex('refresh_tokens', ['tenantId', 'userId'], {
      name: 'refresh_tokens_tenant_user_idx',
    });
    // For clearing out tokens that have simply aged past their expiry.
    await queryInterface.addIndex('refresh_tokens', ['expiresAt'], {
      name: 'refresh_tokens_expires_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('refresh_tokens');
  },
};
