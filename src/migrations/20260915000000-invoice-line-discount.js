'use strict';

/**
 * Per-line discount on a sales invoice.
 *
 * Two columns rather than one. `discountPercent` is what someone entered;
 * `discountPaise` is what it came to. Both are stored because every other money
 * figure on this table is stored rather than recomputed — the invoice PDF and
 * the GST returns read the row as it was raised, and a rate that later changes
 * must not silently restate an invoice already issued.
 *
 * GST: a discount given at the time of supply and shown on the invoice reduces
 * the taxable value (s.15(3)(a) CGST Act), so tax is charged on
 * `quantity * rate - discount`, not on the gross. Storing the discount
 * separately is what lets the invoice show that working rather than presenting
 * a reduced rate the customer never agreed to.
 *
 * Percent rather than an absolute amount, to match `price_list_items
 * .discountPercent`, which is the only other discount this schema carries.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('sales_invoice_lines');

    if (!table.discountPercent) {
      await queryInterface.addColumn('sales_invoice_lines', 'discountPercent', {
        type: Sequelize.DECIMAL(5, 2),
        allowNull: false,
        defaultValue: 0,
      });
    }

    if (!table.discountPaise) {
      await queryInterface.addColumn('sales_invoice_lines', 'discountPaise', {
        type: Sequelize.BIGINT,
        allowNull: false,
        defaultValue: 0,
      });
    }
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('sales_invoice_lines', 'discountPaise').catch(() => {});
    await queryInterface.removeColumn('sales_invoice_lines', 'discountPercent').catch(() => {});
  },
};
