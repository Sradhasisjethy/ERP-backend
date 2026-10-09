'use strict';

/**
 * Per-user read receipts for broadcast notifications.
 *
 * A broadcast (userId null) is one row shared by everyone who can see it, so
 * its single `readAt` column meant the first user to open it cleared it for the
 * whole tenant. Personal notifications keep `readAt`; a broadcast is read *for
 * me* when a row here exists for (notification, me).
 *
 * Legacy broadcasts whose shared `readAt` was already set are left as they are
 * and still count as read — backfilling receipts for every user would invent
 * reads nobody made, and clearing them would resurrect months of old alerts.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('notification_reads')) {
      await queryInterface.createTable('notification_reads', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        notificationId: {
          type: Sequelize.UUID, allowNull: false, references: { model: 'notifications', key: 'id' }, onDelete: 'CASCADE',
        },
        userId: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' }, onDelete: 'CASCADE' },
        readAt: { type: Sequelize.DATE, allowNull: false },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
    }

    // One receipt per user per notification — what lets read-all use
    // ON CONFLICT DO NOTHING and makes two racing clicks harmless.
    await queryInterface.sequelize.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS notification_reads_notification_user_unique
      ON public.notification_reads USING btree ("notificationId", "userId");
    `);
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS notification_reads_tenant_user_idx
      ON public.notification_reads USING btree ("tenantId", "userId");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS notification_reads_tenant_user_idx;');
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS notification_reads_notification_user_unique;');
    await queryInterface.dropTable('notification_reads');
  },
};
