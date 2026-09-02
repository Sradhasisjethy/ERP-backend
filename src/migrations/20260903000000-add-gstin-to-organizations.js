'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('organizations');
    if (!tableInfo.gstin) {
      await queryInterface.addColumn('organizations', 'gstin', {
        type: Sequelize.STRING(15),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const tableInfo = await queryInterface.describeTable('organizations');
    if (tableInfo.gstin) {
      await queryInterface.removeColumn('organizations', 'gstin');
    }
  },
};
