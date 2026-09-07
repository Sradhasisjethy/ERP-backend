'use strict';

/**
 * Marks a product as an accessory — something sold alongside another product
 * rather than on its own.
 *
 * It is a flag on the product master rather than a separate table, because an
 * accessory is a product in every way that matters: it takes a rate from the
 * price list, an HSN code for GST, and stock for availability, and it becomes
 * an ordinary line on the order and the invoice. A parallel "accessories" table
 * would have to reinvent all of that, and would still fail the moment someone
 * sold a cable on its own.
 *
 * The flag exists so the bundle screen can offer a short, curated list instead
 * of every product in the catalogue.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('products', 'isAccessory', {
      type: Sequelize.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    });

    // The bundle form filters on this on every keystroke of the picker.
    await queryInterface.addIndex('products', ['tenantId', 'isAccessory'], {
      name: 'products_tenant_accessory_idx',
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('products', 'products_tenant_accessory_idx');
    await queryInterface.removeColumn('products', 'isAccessory');
  },
};
