'use strict';

/**
 * Leave and attendance for salaried staff.
 *
 * Deliberately separate from `attendance_records`, which is the daily-wage
 * labour register: that one drives what a labourer is paid for a day's work
 * through the workforce module, and folding staff leave into it would make
 * wage totals include people who are not paid that way.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();

    if (!tables.includes('leave_types')) {
      await queryInterface.createTable('leave_types', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        code: { type: Sequelize.STRING(20), allowNull: false },
        name: { type: Sequelize.STRING(80), allowNull: false },
        // Days allowed per year. 0 means unlimited-but-approved (unpaid leave).
        daysPerYear: { type: Sequelize.DECIMAL(5, 1), allowNull: false, defaultValue: 0 },
        isPaid: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        isActive: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
        description: { type: Sequelize.TEXT, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('leave_types', ['tenantId', 'code'], { unique: true, name: 'leave_types_tenant_code_unique' });
    }

    if (!tables.includes('leave_requests')) {
      await queryInterface.createTable('leave_requests', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        employeeId: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' }, onDelete: 'CASCADE' },
        leaveTypeId: { type: Sequelize.UUID, allowNull: false, references: { model: 'leave_types', key: 'id' }, onDelete: 'RESTRICT' },
        fromDate: { type: Sequelize.DATEONLY, allowNull: false },
        toDate: { type: Sequelize.DATEONLY, allowNull: false },
        // Halves are allowed, so this is not simply the date difference.
        days: { type: Sequelize.DECIMAL(5, 1), allowNull: false },
        reason: { type: Sequelize.TEXT, allowNull: true },
        status: { type: Sequelize.ENUM('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'), allowNull: false, defaultValue: 'PENDING' },
        decidedBy: { type: Sequelize.UUID, allowNull: true },
        decidedAt: { type: Sequelize.DATE, allowNull: true },
        decisionNote: { type: Sequelize.TEXT, allowNull: true },
        createdBy: { type: Sequelize.UUID, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      await queryInterface.addIndex('leave_requests', ['tenantId', 'employeeId', 'fromDate'], { name: 'leave_requests_tenant_employee_from' });
      await queryInterface.addIndex('leave_requests', ['tenantId', 'status'], { name: 'leave_requests_tenant_status' });
    }

    if (!tables.includes('staff_attendance')) {
      await queryInterface.createTable('staff_attendance', {
        id: { type: Sequelize.UUID, defaultValue: Sequelize.UUIDV4, primaryKey: true },
        tenantId: { type: Sequelize.UUID, allowNull: false, references: { model: 'tenants', key: 'id' }, onDelete: 'CASCADE' },
        employeeId: { type: Sequelize.UUID, allowNull: false, references: { model: 'employees', key: 'id' }, onDelete: 'CASCADE' },
        factoryId: { type: Sequelize.UUID, allowNull: true, references: { model: 'factories', key: 'id' }, onDelete: 'SET NULL' },
        attendanceDate: { type: Sequelize.DATEONLY, allowNull: false },
        status: {
          type: Sequelize.ENUM('PRESENT', 'ABSENT', 'HALF_DAY', 'ON_LEAVE', 'WEEKLY_OFF', 'HOLIDAY'),
          allowNull: false,
        },
        inTime: { type: Sequelize.STRING(5), allowNull: true },
        outTime: { type: Sequelize.STRING(5), allowNull: true },
        note: { type: Sequelize.TEXT, allowNull: true },
        markedBy: { type: Sequelize.UUID, allowNull: true },
        createdAt: { type: Sequelize.DATE, allowNull: false },
        updatedAt: { type: Sequelize.DATE, allowNull: false },
      });
      // One row per person per day: marking twice corrects the first mark.
      await queryInterface.addIndex('staff_attendance', ['tenantId', 'employeeId', 'attendanceDate'], { unique: true, name: 'staff_attendance_employee_date_unique' });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('staff_attendance').catch(() => {});
    await queryInterface.dropTable('leave_requests').catch(() => {});
    await queryInterface.dropTable('leave_types').catch(() => {});
    for (const type of ['enum_staff_attendance_status', 'enum_leave_requests_status']) {
      await queryInterface.sequelize.query(`DROP TYPE IF EXISTS "${type}";`);
    }
  },
};
