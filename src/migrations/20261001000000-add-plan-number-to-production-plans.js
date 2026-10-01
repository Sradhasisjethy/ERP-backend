'use strict';

/**
 * Adds planNumber to production_plans so each plan has an identifiable
 * reference number, plans and orders can be searched by plan number without
 * SQL crashes, and job cards / orders display a consistent human-readable ID.
 */
module.exports = {
  async up(queryInterface, Sequelize) {
    const tableInfo = await queryInterface.describeTable('production_plans');
    if (!tableInfo.planNumber) {
      await queryInterface.addColumn('production_plans', 'planNumber', {
        type: Sequelize.STRING,
        allowNull: true,
      });
    }

    // Populate planNumber for any existing rows that lack one
    await queryInterface.sequelize.query(`
      UPDATE production_plans
      SET "planNumber" = 'PP-' || replace("planDate"::text, '-', '') || '-' || upper(substring(id::text, 1, 8))
      WHERE "planNumber" IS NULL;
    `);

    // Add index for search and listing
    await queryInterface.sequelize.query(`
      CREATE INDEX IF NOT EXISTS production_plans_tenant_plan_number_idx
      ON public.production_plans USING btree ("tenantId", "planNumber");
    `);
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS production_plans_tenant_plan_number_idx;');
    const tableInfo = await queryInterface.describeTable('production_plans').catch(() => ({}));
    if (tableInfo.planNumber) {
      await queryInterface.removeColumn('production_plans', 'planNumber');
    }
  },
};
