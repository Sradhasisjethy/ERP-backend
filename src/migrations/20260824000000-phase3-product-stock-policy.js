'use strict';

const addColumnIfMissing = async (queryInterface, table, column, spec) => {
  const described = await queryInterface.describeTable(table);
  if (!described[column]) await queryInterface.addColumn(table, column, spec);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    // FR-M03-3: stock policy fields the reorder dashboard reads.
    await addColumnIfMissing(queryInterface, 'products', 'reorderLevel', {
      type: Sequelize.DECIMAL(14, 4), allowNull: false, defaultValue: 0,
    });
    await addColumnIfMissing(queryInterface, 'products', 'minStock', { type: Sequelize.DECIMAL(14, 4), allowNull: true });
    await addColumnIfMissing(queryInterface, 'products', 'maxStock', { type: Sequelize.DECIMAL(14, 4), allowNull: true });

    // FR-M06-1: promised delivery date, used to flag slipped orders.
    await addColumnIfMissing(queryInterface, 'sales_orders', 'expectedDeliveryDate', {
      type: Sequelize.DATEONLY, allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('sales_orders', 'expectedDeliveryDate');
    await queryInterface.removeColumn('products', 'maxStock');
    await queryInterface.removeColumn('products', 'minStock');
    await queryInterface.removeColumn('products', 'reorderLevel');
  },
};
