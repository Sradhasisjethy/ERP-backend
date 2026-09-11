'use strict';

/**
 * B2C counter sales.
 *
 * The existing sales chain is order -> reservation -> challan -> invoice, which
 * is right for a contractor buying on agreed rates and credit terms. A walk-in
 * buying a pallet of pavers has no order to dispatch against, so there was no
 * path to sell to them at all.
 *
 * Three columns, all on sales_invoices. Deliberately no change to
 * delivery_challans: a counter sale raises its invoice at the moment of sale,
 * and under GST goods moving WITH a tax invoice need no separate delivery
 * challan — a challan is the document for movement without one (job work,
 * approval basis, consolidated dispatch billed later, which is exactly the B2B
 * flow here). Making delivery_challans.salesOrderId nullable to hang a
 * redundant second document off a counter sale would have loosened a NOT NULL
 * that the whole B2B path depends on, for a document the law does not ask for.
 * Transport details ride on the invoice instead, and the invoice PDF prints
 * them.
 *
 * saleChannel is NOT the B2B/B2C split for GST. GSTR-1 splits on whether the
 * customer has a GSTIN and must keep doing so — a registered dealer buying at
 * the counter is still a B2B supply, and an unregistered one who ordered ahead
 * is still B2C. This column records which *process* produced the invoice, for
 * operational reporting ("counter takings today"), and nothing in gstr.service
 * reads it.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const table = await queryInterface.describeTable('sales_invoices');

    if (!table.saleChannel) {
      await queryInterface.addColumn('sales_invoices', 'saleChannel', {
        type: Sequelize.ENUM('B2B', 'COUNTER'),
        allowNull: false,
        defaultValue: 'B2B',
      });
    }

    // Free text rather than a vehicles FK: a counter customer's own truck is
    // not in the fleet master, and forcing one in to record a number plate
    // would fill that master with single-use rows.
    if (!table.vehicleNumber) {
      await queryInterface.addColumn('sales_invoices', 'vehicleNumber', {
        type: Sequelize.STRING(32),
        allowNull: true,
      });
    }

    if (!table.driverName) {
      await queryInterface.addColumn('sales_invoices', 'driverName', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }

    // Counter sales are looked up by channel and date ("what did the counter
    // take this week"), which is a scan of the whole table without this.
    await queryInterface.addIndex('sales_invoices', ['tenantId', 'saleChannel', 'invoiceDate'], {
      name: 'sales_invoices_tenant_channel_date',
    }).catch(() => {
      // Re-runnable: the index may already exist on a database that got this
      // migration applied in part. addIndex has no IF NOT EXISTS in Sequelize.
    });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('sales_invoices', 'sales_invoices_tenant_channel_date').catch(() => {});
    await queryInterface.removeColumn('sales_invoices', 'driverName').catch(() => {});
    await queryInterface.removeColumn('sales_invoices', 'vehicleNumber').catch(() => {});
    await queryInterface.removeColumn('sales_invoices', 'saleChannel').catch(() => {});
    // Sequelize creates a backing type for an ENUM column and leaves it behind
    // when the column goes.
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_sales_invoices_saleChannel";').catch(() => {});
  },
};
