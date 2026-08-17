'use strict';

/**
 * Indexes for the Reports module.
 *
 * Every report filters on (tenantId, factoryId, <business date>) — that is the
 * shape of the module's whole query surface: a tenant, the locations the caller
 * may see, and a date window. Before this migration the transactional tables
 * carried only their document-number unique index, so a date-ranged report on
 * a busy factory meant a sequential scan of the whole table for every tenant.
 *
 * The line tables get (tenantId, parentId) and (tenantId, productId) instead:
 * detail reports join lines to their header, and the by-product reports group
 * them. Foreign keys do not create indexes in Postgres, so these are genuinely
 * absent otherwise.
 *
 * Idempotent, matching the convention the earlier phase migrations set — a dev
 * database that has already been altered into shape must not break `db:migrate`.
 */

const addIndexIfMissing = async (queryInterface, table, fields, options) => {
  const tables = await queryInterface.showAllTables();
  if (!tables.includes(table)) return;
  const existing = await queryInterface.showIndex(table);
  if (!existing.some((i) => i.name === options.name)) await queryInterface.addIndex(table, fields, options);
};

/** [table, fields, indexName] — grouped by the report family that needs it. */
const INDEXES = [
  // Sales
  ['sales_invoices', ['tenantId', 'factoryId', 'invoiceDate'], 'rpt_sales_invoices_tenant_factory_date'],
  ['sales_invoices', ['tenantId', 'customerPartyId'], 'rpt_sales_invoices_tenant_customer'],
  ['sales_invoice_lines', ['tenantId', 'salesInvoiceId'], 'rpt_sales_invoice_lines_tenant_invoice'],
  ['sales_invoice_lines', ['tenantId', 'productId'], 'rpt_sales_invoice_lines_tenant_product'],

  // Orders
  ['sales_orders', ['tenantId', 'factoryId', 'orderDate'], 'rpt_sales_orders_tenant_factory_date'],
  ['sales_orders', ['tenantId', 'customerPartyId'], 'rpt_sales_orders_tenant_customer'],
  ['sales_order_lines', ['tenantId', 'salesOrderId'], 'rpt_sales_order_lines_tenant_order'],

  // Purchase
  ['purchase_invoices', ['tenantId', 'factoryId', 'invoiceDate'], 'rpt_purchase_invoices_tenant_factory_date'],
  ['purchase_invoices', ['tenantId', 'vendorPartyId'], 'rpt_purchase_invoices_tenant_vendor'],
  ['goods_receipts', ['tenantId', 'factoryId', 'receiptDate'], 'rpt_goods_receipts_tenant_factory_date'],
  ['goods_receipt_lines', ['tenantId', 'goodsReceiptId'], 'rpt_goods_receipt_lines_tenant_receipt'],
  ['goods_receipt_lines', ['tenantId', 'productId'], 'rpt_goods_receipt_lines_tenant_product'],

  // Dispatch and production
  ['delivery_challans', ['tenantId', 'factoryId', 'dispatchDate'], 'rpt_delivery_challans_tenant_factory_date'],
  ['production_entries', ['tenantId', 'factoryId', 'productionDate'], 'rpt_production_entries_tenant_factory_date'],
  ['material_consumptions', ['tenantId', 'productionEntryId'], 'rpt_material_consumptions_tenant_entry'],
  ['contractor_production_entries', ['tenantId', 'factoryId', 'productionDate'], 'rpt_contractor_entries_tenant_factory_date'],
  ['contractor_production_entries', ['tenantId', 'contractorPartyId'], 'rpt_contractor_entries_tenant_contractor'],

  // Inventory. The ledger is the largest table in the system and every stock
  // report groups it by (factory, product) and slices it by createdAt.
  ['stock_ledger_entries', ['tenantId', 'factoryId', 'productId', 'createdAt'], 'rpt_stock_ledger_tenant_factory_product_date'],
  ['stock_ledger_entries', ['tenantId', 'movementType'], 'rpt_stock_ledger_tenant_movement_type'],
  ['stock_lots', ['tenantId', 'factoryId', 'originDate'], 'rpt_stock_lots_tenant_factory_origin'],
  ['stock_transfers', ['tenantId', 'fromFactoryId', 'initiatedDate'], 'rpt_stock_transfers_tenant_from_date'],
  ['stock_transfers', ['tenantId', 'toFactoryId', 'initiatedDate'], 'rpt_stock_transfers_tenant_to_date'],
  ['stock_transfer_lines', ['tenantId', 'stockTransferId'], 'rpt_stock_transfer_lines_tenant_transfer'],

  // Money
  ['receipts', ['tenantId', 'factoryId', 'receiptDate'], 'rpt_receipts_tenant_factory_date'],
  ['payments', ['tenantId', 'factoryId', 'paymentDate'], 'rpt_payments_tenant_factory_date'],
  ['expenses', ['tenantId', 'factoryId', 'expenseDate'], 'rpt_expenses_tenant_factory_date'],
  ['expenses', ['tenantId', 'category'], 'rpt_expenses_tenant_category'],
  ['journal_lines', ['tenantId', 'journalEntryId'], 'rpt_journal_lines_tenant_entry'],

  // Workforce
  ['attendance_records', ['tenantId', 'factoryId', 'attendanceDate'], 'rpt_attendance_tenant_factory_date'],
];

module.exports = {
  async up(queryInterface) {
    for (const [table, fields, name] of INDEXES) {
      await addIndexIfMissing(queryInterface, table, fields, { name });
    }
  },

  async down(queryInterface) {
    for (const [table, , name] of INDEXES) {
      await queryInterface.removeIndex(table, name).catch(() => {});
    }
  },
};
