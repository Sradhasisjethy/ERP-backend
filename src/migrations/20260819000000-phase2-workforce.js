'use strict';

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('contractor_material_issues', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      issueNumber: { type: Sequelize.STRING, allowNull: false },
      contractorPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      issueDate: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('contractor_material_issues', ['tenantId', 'issueNumber'], { unique: true, name: 'contractor_material_issues_tenant_number_unique' });

    await queryInterface.createTable('contractor_material_issue_lines', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      contractorMaterialIssueId: { type: Sequelize.UUID, allowNull: false, references: { model: 'contractor_material_issues', key: 'id' }, onDelete: 'CASCADE' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      createdLotId: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_lots', key: 'id' }, onDelete: 'RESTRICT' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('contractor_production_entries', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      entryNumber: { type: Sequelize.STRING, allowNull: false },
      contractorPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      productId: { type: Sequelize.UUID, allowNull: false, references: { model: 'products', key: 'id' }, onDelete: 'RESTRICT' },
      mixDesignId: { type: Sequelize.UUID, allowNull: false, references: { model: 'mix_designs', key: 'id' }, onDelete: 'RESTRICT' },
      productionDate: { type: Sequelize.DATEONLY, allowNull: false },
      quantity: { type: Sequelize.DECIMAL(14, 4), allowNull: false },
      pieceRatePaise: { type: Sequelize.BIGINT, allowNull: false },
      totalValuePaise: { type: Sequelize.BIGINT, allowNull: false },
      curingDays: { type: Sequelize.INTEGER, allowNull: false },
      lotId: { type: Sequelize.UUID, allowNull: false, references: { model: 'stock_lots', key: 'id' }, onDelete: 'RESTRICT' },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('contractor_production_entries', ['tenantId', 'entryNumber'], { unique: true, name: 'contractor_production_entries_tenant_number_unique' });

    await queryInterface.createTable('attendance_records', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      labourPartyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      attendanceDate: { type: Sequelize.DATEONLY, allowNull: false },
      status: { type: Sequelize.ENUM('PRESENT', 'HALF_DAY', 'ABSENT', 'OVERTIME'), allowNull: false },
      overtimeHours: { type: Sequelize.DECIMAL(5, 2), allowNull: true },
      wageAccruedPaise: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('attendance_records', ['tenantId', 'labourPartyId', 'attendanceDate'], { unique: true, name: 'attendance_records_labour_date_unique' });

    await queryInterface.createTable('advances', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
      factoryId: { type: Sequelize.UUID, allowNull: false, references: { model: 'factories', key: 'id' }, onDelete: 'RESTRICT' },
      advanceNumber: { type: Sequelize.STRING, allowNull: false },
      partyId: { type: Sequelize.UUID, allowNull: false, references: { model: 'parties', key: 'id' }, onDelete: 'RESTRICT' },
      advanceDate: { type: Sequelize.DATEONLY, allowNull: false },
      mode: { type: Sequelize.ENUM('CASH', 'BANK'), allowNull: false },
      amountPaise: { type: Sequelize.BIGINT, allowNull: false },
      reason: { type: Sequelize.TEXT, allowNull: true },
      status: { type: Sequelize.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('advances', ['tenantId', 'advanceNumber'], { unique: true, name: 'advances_tenant_number_unique' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('advances');
    await queryInterface.dropTable('attendance_records');
    await queryInterface.dropTable('contractor_production_entries');
    await queryInterface.dropTable('contractor_material_issue_lines');
    await queryInterface.dropTable('contractor_material_issues');
  },
};
