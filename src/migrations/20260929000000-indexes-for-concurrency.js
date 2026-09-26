'use strict';

/**
 * Indexes the scalability audit (docs/scalability-audit.md, §7) found missing,
 * each named for the query it serves.
 *
 *   audit_logs (tenantId, createdAt DESC)
 *     The audit screen lists a tenant's history newest first. The only index
 *     was (tenantId, entityType, entityId), so every page view sorted the
 *     tenant's entire audit history — on the fastest-growing table there is.
 *
 *   employees (tenantId)
 *     Every scoped query on employees filters by tenant; only email was indexed.
 *
 *   payment_allocations (receiptId)
 *     Cancelling a receipt, and the counter-sale guard on it, look allocations
 *     up by receipt; only the invoice side was indexed.
 *
 *   sales_orders (tenantId, status)
 *     The dashboard counts open orders by status on every poll.
 *
 *   Trigram indexes for search
 *     Every search box is `ILIKE '%term%'`, which a B-tree cannot serve; each
 *     keystroke was a sequential scan of the tenant's rows. pg_trgm's GIN
 *     indexes are what make a leading-wildcard match use an index. They need
 *     the extension, which needs CREATE privilege on the database; where that
 *     is not granted the migration says so and carries on, because the plain
 *     indexes above must not be held hostage to it.
 */
const TRIGRAM = [
  ['parties', 'name'],
  ['parties', 'code'],
  ['products', 'name'],
  ['products', 'code'],
  ['sales_invoices', 'invoiceNumber'],
  ['sales_orders', 'orderNumber'],
];

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;

    await sequelize.query('CREATE INDEX IF NOT EXISTS audit_logs_tenant_created ON audit_logs ("tenantId", "createdAt" DESC)');
    await sequelize.query('CREATE INDEX IF NOT EXISTS employees_tenant_idx ON employees ("tenantId")');
    await sequelize.query('CREATE INDEX IF NOT EXISTS payment_allocations_receipt_idx ON payment_allocations ("receiptId")');
    await sequelize.query('CREATE INDEX IF NOT EXISTS sales_orders_tenant_status_idx ON sales_orders ("tenantId", status)');

    try {
      await sequelize.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    } catch (error) {
      console.warn(
        `pg_trgm could not be enabled (${error.message.split('\n')[0]}). ` +
          'Search stays on sequential scans until a superuser runs: CREATE EXTENSION pg_trgm; then re-run this migration.'
      );
      return;
    }

    for (const [table, column] of TRIGRAM) {
      await sequelize.query(
        `CREATE INDEX IF NOT EXISTS ${table}_${column.toLowerCase()}_trgm ON ${table} USING gin ("${column}" gin_trgm_ops)`
      );
    }
  },

  async down(queryInterface) {
    const { sequelize } = queryInterface;
    for (const [table, column] of TRIGRAM) {
      await sequelize.query(`DROP INDEX IF EXISTS ${table}_${column.toLowerCase()}_trgm`);
    }
    await sequelize.query('DROP INDEX IF EXISTS sales_orders_tenant_status_idx');
    await sequelize.query('DROP INDEX IF EXISTS payment_allocations_receipt_idx');
    await sequelize.query('DROP INDEX IF EXISTS employees_tenant_idx');
    await sequelize.query('DROP INDEX IF EXISTS audit_logs_tenant_created');
  },
};
