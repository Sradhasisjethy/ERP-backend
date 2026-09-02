'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('office_departments').catch(() => null);
    if (!tableInfo) {
      await queryInterface.createTable('office_departments', {
        id: {
          type: Sequelize.UUID,
          defaultValue: Sequelize.UUIDV4,
          primaryKey: true,
        },
        tenantId: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'tenants', key: 'id' },
          onDelete: 'CASCADE',
        },
        officeId: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'offices', key: 'id' },
          onDelete: 'CASCADE',
        },
        departmentId: {
          type: Sequelize.UUID,
          allowNull: false,
          references: { model: 'departments', key: 'id' },
          onDelete: 'CASCADE',
        },
        createdAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
        updatedAt: {
          type: Sequelize.DATE,
          allowNull: false,
        },
      });

      await queryInterface.addIndex('office_departments', ['officeId', 'departmentId'], {
        unique: true,
        name: 'office_departments_office_dept_unique',
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.dropTable('office_departments');
  },
};
