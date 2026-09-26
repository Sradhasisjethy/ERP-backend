'use strict';

/**
 * The one unique index `20260928000000-restore-unique-indexes.js` had to leave
 * out: two financial years coded 2027-28 sat in the development database, so
 * creating it would have failed. The duplicate — a closed, empty test row —
 * has since been deleted through FactoryService.deleteFinancialYear, so the
 * index can now exist. Without it two users can create the same year code at
 * once and every "current year" lookup afterwards is ambiguous.
 */
module.exports = {
  async up(queryInterface) {
    await queryInterface.sequelize.query(
      'CREATE UNIQUE INDEX IF NOT EXISTS financial_years_tenant_code_unique ON public.financial_years USING btree ("tenantId", code)'
    );
  },

  async down(queryInterface) {
    await queryInterface.sequelize.query('DROP INDEX IF EXISTS financial_years_tenant_code_unique');
  },
};
