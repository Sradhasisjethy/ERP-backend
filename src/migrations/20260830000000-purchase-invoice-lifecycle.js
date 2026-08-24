'use strict';

/**
 * Gives the purchase invoice a lifecycle and a uniqueness rule.
 *
 * Two defects made this necessary:
 *
 * 1. **A purchase invoice could never be cancelled.** The model had no status
 *    column at all, so a mis-keyed vendor bill stayed on the payables ledger
 *    permanently — there was no correction path anywhere on the purchase side
 *    (the goods receipt had a CANCELLED enum value but no code to reach it).
 *    `status` mirrors the sales invoice, which has had POSTED/CANCELLED from
 *    the start.
 *
 * 2. **Nothing stopped a second invoice against the same goods receipt.** That
 *    doubled the vendor payable and — because GSTR-3B derives input tax credit
 *    by walking the GRN lines behind each purchase invoice — doubled the ITC
 *    claimed on the return as well. The partial unique index makes the
 *    database the backstop; the service check exists for the error message.
 *    It is partial on `status = 'POSTED'` so a genuinely cancelled invoice can
 *    be re-raised against its receipt.
 *
 * A vendor's own invoice number is also made unique per vendor, which is what
 * stops the same bill being entered twice under two different GRNs.
 *
 * Idempotent, matching the convention the phase migrations set.
 */

const addColumnIfMissing = async (queryInterface, table, column, spec) => {
  const described = await queryInterface.describeTable(table);
  if (!described[column]) await queryInterface.addColumn(table, column, spec);
};

const indexExists = async (queryInterface, table, name) => {
  const existing = await queryInterface.showIndex(table);
  return existing.some((i) => i.name === name);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('purchase_invoices')) return;

    await addColumnIfMissing(queryInterface, 'purchase_invoices', 'status', {
      type: Sequelize.ENUM('POSTED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'POSTED',
    });
    await addColumnIfMissing(queryInterface, 'purchase_invoices', 'cancelReason', {
      type: Sequelize.TEXT,
      allowNull: true,
    });

    if (!(await indexExists(queryInterface, 'purchase_invoices', 'purchase_invoices_grn_posted_unique'))) {
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "purchase_invoices_grn_posted_unique"
           ON "purchase_invoices" ("tenantId", "goodsReceiptId")
         WHERE "status" = 'POSTED'`
      );
    }

    if (!(await indexExists(queryInterface, 'purchase_invoices', 'purchase_invoices_vendor_number_unique'))) {
      await queryInterface.sequelize.query(
        `CREATE UNIQUE INDEX "purchase_invoices_vendor_number_unique"
           ON "purchase_invoices" ("tenantId", "vendorPartyId", "vendorInvoiceNumber")
         WHERE "status" = 'POSTED'`
      );
    }

    // The payables and vendor-ledger reports filter on these.
    if (!(await indexExists(queryInterface, 'purchase_invoices', 'purchase_invoices_tenant_status_idx'))) {
      await queryInterface.addIndex('purchase_invoices', ['tenantId', 'status'], { name: 'purchase_invoices_tenant_status_idx' });
    }
  },

  async down(queryInterface) {
    for (const name of [
      'purchase_invoices_grn_posted_unique',
      'purchase_invoices_vendor_number_unique',
      'purchase_invoices_tenant_status_idx',
    ]) {
      await queryInterface.sequelize.query(`DROP INDEX IF EXISTS "${name}"`).catch(() => {});
    }
    await queryInterface.removeColumn('purchase_invoices', 'cancelReason').catch(() => {});
    await queryInterface.removeColumn('purchase_invoices', 'status').catch(() => {});
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_purchase_invoices_status"').catch(() => {});
  },
};
