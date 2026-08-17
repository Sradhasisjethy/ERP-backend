'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('accounts', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      code: { type: Sequelize.STRING, allowNull: false },
      name: { type: Sequelize.STRING, allowNull: false },
      type: { type: Sequelize.ENUM('ASSET', 'LIABILITY', 'EQUITY', 'INCOME', 'EXPENSE'), allowNull: false },
      isPartyControlAccount: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('accounts', ['tenantId', 'code'], { unique: true, name: 'accounts_tenant_code_unique' });

    await queryInterface.createTable('journal_entries', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      entryDate: { type: Sequelize.DATEONLY, allowNull: false },
      referenceType: { type: Sequelize.STRING, allowNull: false },
      referenceId: { type: Sequelize.UUID, allowNull: false },
      narration: { type: Sequelize.STRING, allowNull: true },
      totalDebitPaise: { type: Sequelize.BIGINT, allowNull: false },
      totalCreditPaise: { type: Sequelize.BIGINT, allowNull: false },
      reversalOfEntryId: { type: Sequelize.UUID, allowNull: true, references: { model: 'journal_entries', key: 'id' }, onDelete: 'SET NULL' },
      createdBy: { type: Sequelize.UUID, allowNull: true, references: { model: 'employees', key: 'id' }, onDelete: 'SET NULL' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('journal_entries', ['tenantId', 'referenceType', 'referenceId'], { name: 'journal_entries_reference_idx' });
    await queryInterface.addIndex('journal_entries', ['tenantId', 'factoryId', 'entryDate'], { name: 'journal_entries_factory_date_idx' });

    await queryInterface.createTable('journal_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      journalEntryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'journal_entries', key: 'id' }, onDelete: 'CASCADE' },
      accountId: { type: Sequelize.UUID, allowNull: false, references: { model: 'accounts', key: 'id' }, onDelete: 'RESTRICT' },
      partyId: { type: Sequelize.UUID, allowNull: true, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      debitPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      creditPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('journal_lines', ['tenantId', 'accountId'], { name: 'journal_lines_account_idx' });
    await queryInterface.addIndex('journal_lines', ['tenantId', 'partyId'], { name: 'journal_lines_party_idx' });

    // Add the new inventory columns/enum values needed by Phase 2 (contractor
    // job-work, sales returns) — extending existing tables rather than a
    // separate migration since they're small, additive, and land alongside
    // the module that first uses them.
    await queryInterface.addColumn('stock_lots', 'heldByPartyId', {
      type: Sequelize.UUID, allowNull: true, references: { model: 'parties', key: 'id' }, onDelete: 'SET NULL',
    });

    // Postgres requires ADD VALUE outside the values already in the type;
    // IF NOT EXISTS (PG 12+) makes this migration safe to re-run.
    await queryInterface.sequelize.query(`ALTER TYPE "enum_stock_lots_originType" ADD VALUE IF NOT EXISTS 'SALES_RETURN'`);
    await queryInterface.sequelize.query(`ALTER TYPE "enum_stock_lots_originType" ADD VALUE IF NOT EXISTS 'CONTRACTOR_ISSUE'`);
    await queryInterface.sequelize.query(`ALTER TYPE "enum_stock_ledger_entries_movementType" ADD VALUE IF NOT EXISTS 'RETURN_IN'`);
    await queryInterface.sequelize.query(`ALTER TYPE "enum_stock_ledger_entries_movementType" ADD VALUE IF NOT EXISTS 'RETURN_OUT'`);
    await queryInterface.sequelize.query(`ALTER TYPE "enum_stock_ledger_entries_movementType" ADD VALUE IF NOT EXISTS 'CONTRACTOR_ISSUE_OUT'`);
    await queryInterface.sequelize.query(`ALTER TYPE "enum_stock_ledger_entries_movementType" ADD VALUE IF NOT EXISTS 'CONTRACTOR_ISSUE_IN'`);
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('stock_lots', 'heldByPartyId');
    await queryInterface.dropTable('journal_lines');
    await queryInterface.dropTable('journal_entries');
    await queryInterface.dropTable('accounts');
  },
};
