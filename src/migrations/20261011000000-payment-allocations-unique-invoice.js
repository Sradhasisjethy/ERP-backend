'use strict';

/**
 * One receipt (or payment) may allocate to a given invoice once.
 *
 * The API refused a repeated invoiceId with a Set of raw strings, but zod's
 * .uuid() keeps case and Postgres compares uuids case-insensitively, so the
 * same invoice written once upper-case and once lower-case got through as two
 * lines — and the per-line over-allocation check let it be settled twice. The
 * schema and service now lower-case the id; these indexes are the backstop for
 * whatever path is added next.
 *
 * Partial indexes, because an allocation belongs to a receipt OR a payment and
 * the other column is NULL; a plain unique index would treat every NULL as
 * distinct anyway, but the WHERE clause keeps each index to its own rows.
 * invoiceType is included so the key matches the polymorphic reference.
 *
 * Existing duplicates are reported, not removed. These are financial rows: which
 * line is the mistake, and whether the ledger needs a correcting entry, is an
 * accountant's decision. The migration stops with the counts and the query
 * that lists them, and can be re-run once they are resolved.
 */
const INDEXES = [
  { name: 'payment_allocations_receipt_invoice_unique', parent: 'receiptId' },
  { name: 'payment_allocations_payment_invoice_unique', parent: 'paymentId' },
];

const duplicatesQuery = (parent) =>
  `SELECT "${parent}", "invoiceType", "invoiceId", count(*) AS lines
     FROM payment_allocations
    WHERE "${parent}" IS NOT NULL
    GROUP BY "${parent}", "invoiceType", "invoiceId"
   HAVING count(*) > 1`;

module.exports = {
  async up(queryInterface) {
    const { sequelize } = queryInterface;
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('payment_allocations')) return;

    const problems = [];
    for (const { parent } of INDEXES) {
      const [[found]] = await sequelize.query(
        `SELECT count(*)::int AS groups, COALESCE(sum(lines - 1), 0)::int AS extra FROM (${duplicatesQuery(parent)}) d`
      );
      if (found.groups > 0) {
        problems.push(
          `${found.groups} ${parent === 'receiptId' ? 'receipt' : 'payment'}/invoice pair(s) with ${found.extra} extra allocation line(s) — list them with: ${duplicatesQuery(parent).replace(/\s+/g, ' ')}`
        );
      }
    }
    if (problems.length) {
      throw new Error(
        'payment_allocations already holds duplicate allocations, so the unique indexes cannot be created. '
          + 'Nothing was changed. Resolve each pair by hand (merge the lines, or cancel and re-enter the document) and re-run the migration. '
          + problems.join(' ; ')
      );
    }

    for (const { name, parent } of INDEXES) {
      await sequelize.query(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${name}
            ON payment_allocations ("${parent}", "invoiceType", "invoiceId")
         WHERE "${parent}" IS NOT NULL`
      );
    }
  },

  async down(queryInterface) {
    const { sequelize } = queryInterface;
    for (const { name } of INDEXES) {
      await sequelize.query(`DROP INDEX IF EXISTS ${name}`);
    }
  },
};
