'use strict';

/**
 * GST on a sales return.
 *
 * A sales invoice charges the customer tax and posts it to GST Output. When
 * goods come back, the tax has to come back with them (s.34 CGST Act): the
 * customer is credited the tax-inclusive amount and the output liability is
 * reduced. Returns were storing and posting the net value only, so the customer
 * was under-credited and the GST on returned goods stayed on the books as a
 * liability that was no longer owed.
 *
 * `totalAmountPaise` becomes the tax-inclusive total, as it already is on an
 * invoice, and `subtotalPaise` holds the value it used to carry. Existing rows
 * are backfilled with their old figure as the subtotal and zero tax — which is
 * exactly what they recorded, and inventing tax for them would be worse.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const money = { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 };

    const returns = await queryInterface.describeTable('sales_returns');
    for (const column of ['subtotalPaise', 'cgstPaise', 'sgstPaise', 'igstPaise']) {
      if (!returns[column]) await queryInterface.addColumn('sales_returns', column, money);
    }

    const lines = await queryInterface.describeTable('sales_return_lines');
    if (!lines.gstRatePercent) {
      await queryInterface.addColumn('sales_return_lines', 'gstRatePercent', {
        type: Sequelize.DECIMAL(5, 2), allowNull: false, defaultValue: 0,
      });
    }
    for (const column of ['taxableAmountPaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'lineTotalPaise']) {
      if (!lines[column]) await queryInterface.addColumn('sales_return_lines', column, money);
    }

    // What the existing rows meant: the whole amount was the taxable value.
    await queryInterface.sequelize.query(`
      UPDATE sales_returns SET "subtotalPaise" = "totalAmountPaise" WHERE "subtotalPaise" = 0;
    `);
    await queryInterface.sequelize.query(`
      UPDATE sales_return_lines
         SET "taxableAmountPaise" = ROUND(quantity * "ratePaise"),
             "lineTotalPaise"     = ROUND(quantity * "ratePaise")
       WHERE "taxableAmountPaise" = 0;
    `);
  },

  async down(queryInterface) {
    for (const column of ['taxableAmountPaise', 'cgstPaise', 'sgstPaise', 'igstPaise', 'lineTotalPaise', 'gstRatePercent']) {
      await queryInterface.removeColumn('sales_return_lines', column).catch(() => {});
    }
    for (const column of ['subtotalPaise', 'cgstPaise', 'sgstPaise', 'igstPaise']) {
      await queryInterface.removeColumn('sales_returns', column).catch(() => {});
    }
  },
};
