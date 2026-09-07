'use strict';

/**
 * Replay protection for mutating requests.
 *
 * A salesperson on a patchy site connection taps "add" and sees nothing happen,
 * so they tap again. Without this the order gets two printers and two sets of
 * accessories, and nobody notices until the lorry is loaded. The client sends
 * an `Idempotency-Key` per intended action and a retry carries the same one.
 *
 * The unique index on (tenantId, key) IS the guarantee — the middleware claims
 * a row before doing any work, so two requests racing on the same key cannot
 * both proceed, whatever the application layer does.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('idempotency_keys', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },

      key: { type: Sequelize.STRING(200), allowNull: false },
      // Method and path, so the same key on a different endpoint is a client
      // bug rather than a replay, and is refused as one.
      endpoint: { type: Sequelize.STRING(300), allowNull: false },
      // Hash of the request body. A key replayed with a *different* payload is
      // not a retry — returning the first response would silently discard the
      // second request.
      requestHash: { type: Sequelize.STRING(64), allowNull: false },

      status: { type: Sequelize.ENUM('IN_PROGRESS', 'COMPLETED'), allowNull: false, defaultValue: 'IN_PROGRESS' },
      statusCode: { type: Sequelize.INTEGER, allowNull: true },
      responseBody: { type: Sequelize.JSONB, allowNull: true },

      userId: { type: Sequelize.UUID, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.addIndex('idempotency_keys', ['tenantId', 'key'], {
      unique: true,
      name: 'idempotency_keys_tenant_key_unique',
    });
    // For the periodic clear-out; these rows are only useful for as long as a
    // client might still retry.
    await queryInterface.addIndex('idempotency_keys', ['createdAt'], {
      name: 'idempotency_keys_created_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('idempotency_keys');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_idempotency_keys_status";');
  },
};
