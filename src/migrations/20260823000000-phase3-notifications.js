'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('notifications')) return;

    await queryInterface.createTable('notifications', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      type: {
        type: Sequelize.ENUM(
          'NEGATIVE_STOCK', 'DEAD_STOCK', 'NEAR_DEAD_STOCK', 'REORDER_LEVEL', 'OVERDUE_RECEIVABLE',
          'CREDIT_LIMIT_BREACH', 'ORDER_PAST_DELIVERY_DATE', 'CURING_COMPLETE', 'EARLY_CURING_RELEASE',
          'NEGATIVE_CASH', 'STALE_RESERVATION', 'VARIANCE_APPROVAL_PENDING', 'LEDGER_BALANCE_DRIFT', 'JOB_FAILED'
        ),
        allowNull: false,
      },
      severity: { type: Sequelize.ENUM('LOW', 'MEDIUM', 'HIGH', 'CRITICAL'), allowNull: false, defaultValue: 'MEDIUM' },
      title: { type: Sequelize.STRING, allowNull: false },
      message: { type: Sequelize.TEXT, allowNull: false },
      metadata: { type: Sequelize.JSONB, allowNull: false, defaultValue: {} },
      factoryId: { type: Sequelize.UUID, allowNull: true, references: { model: 'factories', key: 'id' }, onDelete: 'CASCADE' },
      entityType: { type: Sequelize.STRING, allowNull: true },
      entityId: { type: Sequelize.UUID, allowNull: true },
      userId: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'CASCADE' },
      dedupeKey: { type: Sequelize.STRING, allowNull: false },
      readAt: { type: Sequelize.DATE, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    // This unique index IS the idempotency guarantee for FR-M24-5 — two job
    // runs racing each other still produce exactly one notification.
    await queryInterface.addIndex('notifications', ['tenantId', 'dedupeKey'], {
      unique: true, name: 'notifications_tenant_dedupe_unique',
    });
    await queryInterface.addIndex('notifications', ['tenantId', 'readAt'], { name: 'notifications_tenant_unread_idx' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('notifications');
  },
};
