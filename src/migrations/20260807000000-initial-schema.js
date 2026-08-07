'use strict';

const STATUS_ACTIVE_INACTIVE = ['active', 'inactive'];

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable('tenants', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      name: { type: Sequelize.STRING, allowNull: false },
      slug: { type: Sequelize.STRING, allowNull: false, unique: true },
      domain: { type: Sequelize.STRING, allowNull: true },
      status: { type: Sequelize.ENUM('active', 'inactive', 'suspended'), defaultValue: 'active' },
      settings: { type: Sequelize.JSONB, defaultValue: {} },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('organizations', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING, allowNull: false },
      code: { type: Sequelize.STRING, allowNull: true },
      description: { type: Sequelize.TEXT, allowNull: true },
      status: { type: Sequelize.ENUM(...STATUS_ACTIVE_INACTIVE), defaultValue: 'active' },
      settings: { type: Sequelize.JSONB, defaultValue: {} },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('offices', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      organizationId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'organizations', key: 'id' },
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING, allowNull: false },
      code: { type: Sequelize.STRING, allowNull: true },
      address: { type: Sequelize.TEXT, allowNull: true },
      city: { type: Sequelize.STRING, allowNull: true },
      state: { type: Sequelize.STRING, allowNull: true },
      country: { type: Sequelize.STRING, allowNull: true },
      geofenceRadius: { type: Sequelize.INTEGER, defaultValue: 100 },
      latitude: { type: Sequelize.DECIMAL(10, 8), allowNull: true },
      longitude: { type: Sequelize.DECIMAL(11, 8), allowNull: true },
      status: { type: Sequelize.ENUM(...STATUS_ACTIVE_INACTIVE), defaultValue: 'active' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('departments', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      organizationId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'organizations', key: 'id' },
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING, allowNull: false },
      code: { type: Sequelize.STRING, allowNull: true },
      parentId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'departments', key: 'id' },
        onDelete: 'SET NULL',
      },
      // No FK constraint: heads reference employees, which is created after this table
      // (and the app never declared this as a Sequelize association either).
      headId: { type: Sequelize.UUID, allowNull: true },
      status: { type: Sequelize.ENUM(...STATUS_ACTIVE_INACTIVE), defaultValue: 'active' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('ad_groups', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      name: { type: Sequelize.STRING, allowNull: false },
      code: { type: Sequelize.STRING, allowNull: true },
      description: { type: Sequelize.TEXT, allowNull: true },
      permissions: { type: Sequelize.JSONB, defaultValue: [] },
      status: { type: Sequelize.ENUM(...STATUS_ACTIVE_INACTIVE), defaultValue: 'active' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('employees', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      organizationId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'organizations', key: 'id' },
        onDelete: 'SET NULL',
      },
      officeId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'offices', key: 'id' },
        onDelete: 'SET NULL',
      },
      departmentId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'departments', key: 'id' },
        onDelete: 'SET NULL',
      },
      email: { type: Sequelize.STRING, allowNull: false, unique: true },
      passwordHash: { type: Sequelize.STRING, allowNull: false },
      firstName: { type: Sequelize.STRING, allowNull: false },
      lastName: { type: Sequelize.STRING, allowNull: false },
      employeeCode: { type: Sequelize.STRING, allowNull: true },
      phone: { type: Sequelize.STRING, allowNull: true },
      employeeType: {
        type: Sequelize.ENUM('FULL_TIME', 'PART_TIME', 'CONTRACT', 'INTERN'),
        defaultValue: 'FULL_TIME',
      },
      status: {
        type: Sequelize.ENUM('ACTIVE', 'INACTIVE', 'ONBOARDING', 'TERMINATED'),
        defaultValue: 'ONBOARDING',
      },
      isSystem: { type: Sequelize.BOOLEAN, defaultValue: false },
      managerId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'employees', key: 'id' },
        onDelete: 'SET NULL',
      },
      hrId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'employees', key: 'id' },
        onDelete: 'SET NULL',
      },
      parentId: {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'employees', key: 'id' },
        onDelete: 'SET NULL',
      },
      dateOfJoining: { type: Sequelize.DATEONLY, allowNull: true },
      role: {
        type: Sequelize.ENUM('PLATFORM_ADMIN', 'TENANT_OWNER', 'ORG_ADMIN', 'HR_ADMIN', 'MANAGER', 'EMPLOYEE'),
        defaultValue: 'EMPLOYEE',
      },
      avatar: { type: Sequelize.STRING, allowNull: true },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('ad_group_members', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      adGroupId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'ad_groups', key: 'id' },
        onDelete: 'CASCADE',
      },
      employeeId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'employees', key: 'id' },
        onDelete: 'CASCADE',
      },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('ad_group_members', ['adGroupId', 'employeeId'], {
      unique: true,
      name: 'ad_group_members_group_employee_unique',
    });

    await queryInterface.createTable('tenant_settings', {
      id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
      tenantId: {
        type: Sequelize.UUID,
        allowNull: false,
        references: { model: 'tenants', key: 'id' },
        onDelete: 'CASCADE',
      },
      key: { type: Sequelize.STRING, allowNull: false },
      value: { type: Sequelize.JSONB, allowNull: true },
      category: { type: Sequelize.STRING, allowNull: true, defaultValue: 'general' },
      createdAt: { type: Sequelize.DATE, allowNull: false },
      updatedAt: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('tenant_settings', ['tenantId', 'key'], {
      unique: true,
      name: 'tenant_settings_key_unique',
    });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('tenant_settings');
    await queryInterface.dropTable('ad_group_members');
    await queryInterface.dropTable('employees');
    await queryInterface.dropTable('ad_groups');
    await queryInterface.dropTable('departments');
    await queryInterface.dropTable('offices');
    await queryInterface.dropTable('organizations');
    await queryInterface.dropTable('tenants');
  },
};
