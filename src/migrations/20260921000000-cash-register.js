'use strict';

/**
 * Cash register sessions for the counter.
 *
 * A session is a shift at a till: the drawer is counted when it opens and
 * again when it closes, and each count is compared with what the cash account
 * says should be there. The difference is the thing worth knowing, and it is
 * what this table exists to record.
 *
 * Money is not moved by a session. Cash sales, petty payouts and top-ups all
 * post through the modules that already own them (counter sales, expenses,
 * contra vouchers); only a counted difference posts a journal of its own, and
 * only when someone accepts it.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (tables.includes('cash_register_sessions')) return;

    await queryInterface.createTable('cash_register_sessions', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      // The cash account this till holds. NULL means the system Cash-in-Hand.
      accountId: { type: Sequelize.UUID, allowNull: true, references: { model: 'accounts', key: 'id' }, onDelete: 'RESTRICT' },
      sessionNumber: { type: Sequelize.STRING, allowNull: false },
      status: { type: Sequelize.ENUM('OPEN', 'CLOSED'), allowNull: false, defaultValue: 'OPEN' },

      openedAt: { type: Sequelize.DATE, allowNull: false },
      openedBy: { type: Sequelize.UUID, allowNull: true },
      // { "500": 10, "200": 3, ... } — note or coin value to how many of them.
      openingDenominations: { type: Sequelize.JSONB, allowNull: true },
      openingCountedPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      openingExpectedPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      openingVariancePaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },

      closedAt: { type: Sequelize.DATE, allowNull: true },
      closedBy: { type: Sequelize.UUID, allowNull: true },
      closingDenominations: { type: Sequelize.JSONB, allowNull: true },
      closingCountedPaise: { type: Sequelize.BIGINT, allowNull: true },
      closingExpectedPaise: { type: Sequelize.BIGINT, allowNull: true },
      closingVariancePaise: { type: Sequelize.BIGINT, allowNull: true },
      // True when the closing difference was written to the books.
      varianceAdjusted: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },

      openingNote: { type: Sequelize.TEXT, allowNull: true },
      closingNote: { type: Sequelize.TEXT, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('cash_register_sessions', ['tenantId', 'sessionNumber'], { unique: true, name: 'cash_sessions_tenant_number_unique' });
    await queryInterface.addIndex('cash_register_sessions', ['tenantId', 'factoryId', 'status'], { name: 'cash_sessions_tenant_factory_status' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('cash_register_sessions').catch(() => {});
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_cash_register_sessions_status";');
  },
};
