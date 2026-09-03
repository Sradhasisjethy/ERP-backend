'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('employees');
    if (!tableInfo.gender) {
      await queryInterface.addColumn('employees', 'gender', {
        type: Sequelize.STRING(50),
        allowNull: true,
      });
    }
    if (!tableInfo.assetName) {
      await queryInterface.addColumn('employees', 'assetName', {
        type: Sequelize.STRING(255),
        allowNull: true,
      });
    }
    if (!tableInfo.assetCode) {
      await queryInterface.addColumn('employees', 'assetCode', {
        type: Sequelize.STRING(100),
        allowNull: true,
      });
    }
    if (!tableInfo.resignationDate) {
      await queryInterface.addColumn('employees', 'resignationDate', {
        type: Sequelize.DATEONLY,
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const tableInfo = await queryInterface.describeTable('employees');
    if (tableInfo.resignationDate) await queryInterface.removeColumn('employees', 'resignationDate');
    if (tableInfo.assetCode) await queryInterface.removeColumn('employees', 'assetCode');
    if (tableInfo.assetName) await queryInterface.removeColumn('employees', 'assetName');
    if (tableInfo.gender) await queryInterface.removeColumn('employees', 'gender');
  },
};
