'use strict';

/**
 * A user-maintained chart of accounts, several bank and cash accounts, and
 * journal/contra vouchers.
 *
 * Until now the chart held only the system accounts posting services create
 * for themselves, with one "Bank Account" for every bank the business uses. A
 * loan, a capital introduction, a bank-to-bank transfer or the monthly GST
 * set-off had nowhere to go.
 *
 * Everything here is additive. Existing rows get a NULL group (resolved from
 * the system-account definition in code) and stay active; every existing
 * posting path keeps writing to the same system accounts it always has, and
 * only uses a specific bank account when a caller names one.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const accounts = await queryInterface.describeTable('accounts');
    const addAccountColumn = async (name, spec) => {
      if (!accounts[name]) await queryInterface.addColumn('accounts', name, spec);
    };

    // Where the account prints in the statements. NULL for rows created before
    // this column — the system-account definition supplies it.
    await addAccountColumn('accountGroup', { type: Sequelize.STRING(40), allowNull: true });
    // BANK or CASH marks an account money can be received into or paid from.
    await addAccountColumn('subType', { type: Sequelize.STRING(16), allowNull: true });
    await addAccountColumn('isActive', { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true });
    await addAccountColumn('description', { type: Sequelize.TEXT, allowNull: true });
    await addAccountColumn('bankName', { type: Sequelize.STRING(120), allowNull: true });
    await addAccountColumn('accountNumber', { type: Sequelize.STRING(40), allowNull: true });
    await addAccountColumn('ifsc', { type: Sequelize.STRING(11), allowNull: true });
    await addAccountColumn('branch', { type: Sequelize.STRING(120), allowNull: true });

    // Which bank a cheque was deposited into or drawn on, so bank charges on a
    // bounce hit the same account the cheque was posted to.
    const cheques = await queryInterface.describeTable('cheques');
    if (!cheques.accountId) {
      await queryInterface.addColumn('cheques', 'accountId', {
        type: Sequelize.UUID, allowNull: true, references: { model: 'accounts', key: 'id' }, onDelete: 'RESTRICT',
      });
    }

    // Which cash or bank account an expense was paid from. NULL keeps the old
    // meaning: the system Cash-in-Hand or Bank Account, by mode.
    const expenses = await queryInterface.describeTable('expenses');
    if (!expenses.accountId) {
      await queryInterface.addColumn('expenses', 'accountId', {
        type: Sequelize.UUID, allowNull: true, references: { model: 'accounts', key: 'id' }, onDelete: 'RESTRICT',
      });
    }

    const tables = await queryInterface.showAllTables();
    if (!tables.includes('journal_vouchers')) {
      await queryInterface.createTable('journal_vouchers', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
        voucherNumber: { type: Sequelize.STRING, allowNull: false },
        voucherType: { type: Sequelize.ENUM('JOURNAL', 'CONTRA'), allowNull: false },
        voucherDate: { type: Sequelize.DATEONLY, allowNull: false },
        narration: { type: Sequelize.TEXT, allowNull: false },
        totalPaise: { type: Sequelize.BIGINT, allowNull: false },
        status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
        cancelReason: { type: Sequelize.TEXT, allowNull: true },
        createdBy: { type: Sequelize.UUID, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('journal_vouchers', ['tenantId', 'voucherNumber'], { unique: true, name: 'journal_vouchers_tenant_number_unique' });
      await queryInterface.addIndex('journal_vouchers', ['tenantId', 'factoryId', 'voucherDate'], { name: 'journal_vouchers_tenant_factory_date' });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('journal_vouchers').catch(() => {});
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_journal_vouchers_voucherType";');
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_journal_vouchers_status";');
    await queryInterface.removeColumn('expenses', 'accountId').catch(() => {});
    await queryInterface.removeColumn('cheques', 'accountId').catch(() => {});
    for (const column of ['branch', 'ifsc', 'accountNumber', 'bankName', 'description', 'isActive', 'subType', 'accountGroup']) {
      await queryInterface.removeColumn('accounts', column).catch(() => {});
    }
  },
};
