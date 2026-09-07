'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('employees');
    if (!tableInfo.address) {
      await queryInterface.addColumn('employees', 'address', {
        type: Sequelize.TEXT,
        allowNull: true,
      });
    }
    if (!tableInfo.city) {
      await queryInterface.addColumn('employees', 'city', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!tableInfo.state) {
      await queryInterface.addColumn('employees', 'state', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!tableInfo.country) {
      await queryInterface.addColumn('employees', 'country', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }
    if (!tableInfo.pincode) {
      await queryInterface.addColumn('employees', 'pincode', {
        type: Sequelize.STRING(20),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const tableInfo = await queryInterface.describeTable('employees');
    if (tableInfo.pincode) await queryInterface.removeColumn('employees', 'pincode');
    if (tableInfo.country) await queryInterface.removeColumn('employees', 'country');
    if (tableInfo.state) await queryInterface.removeColumn('employees', 'state');
    if (tableInfo.city) await queryInterface.removeColumn('employees', 'city');
    if (tableInfo.address) await queryInterface.removeColumn('employees', 'address');
  },
};
