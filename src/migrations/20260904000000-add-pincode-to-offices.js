'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('offices');
    if (!tableInfo.pincode) {
      await queryInterface.addColumn('offices', 'pincode', {
        type: Sequelize.STRING(20),
        allowNull: true,
      });
    }
  },

  async down(queryInterface) {
    const tableInfo = await queryInterface.describeTable('offices');
    if (tableInfo.pincode) {
      await queryInterface.removeColumn('offices', 'pincode');
    }
  },
};
