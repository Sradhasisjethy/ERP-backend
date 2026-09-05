'use strict';

/**
 * Makes `override_reason_codes` genuinely per-tenant.
 *
 * As first written the table used `code` alone as its primary key, which made
 * every reason code globally unique across the whole platform: once one tenant
 * had ALREADY_HAS, no other tenant could ever create it. The seeding script
 * surfaced it immediately — the first tenant got its four codes and the next
 * failed with a unique violation.
 *
 * The fix is the shape every other table here already uses: a surrogate UUID
 * primary key, with `(tenantId, code)` unique. A code is then unique *within* a
 * tenant, which is what was meant all along.
 *
 * `bundle_component_suppressions.reasonCode` pointed at the old primary key, so
 * it becomes a composite foreign key on `(tenantId, reasonCode)` — which is
 * stronger than before: it now also guarantees a suppression cannot reference
 * another tenant's reason code.
 */
const FK = 'bundle_component_suppressions_reasonCode_fkey';

module.exports = {
  async up(queryInterface, Sequelize) {
    const { sequelize } = queryInterface;

    await sequelize.transaction(async (transaction) => {
      const opts = { transaction };

      await sequelize.query(
        `ALTER TABLE "bundle_component_suppressions" DROP CONSTRAINT IF EXISTS "${FK}"`, opts
      );
      await sequelize.query(
        'ALTER TABLE "override_reason_codes" DROP CONSTRAINT IF EXISTS "override_reason_codes_pkey"', opts
      );

      // `ADD COLUMN IF NOT EXISTS` rather than a describeTable() check.
      // describeTable runs on its own connection, so calling it here would wait
      // for the ACCESS EXCLUSIVE lock this very transaction is holding from the
      // DROP CONSTRAINT above — the migration deadlocking against itself, which
      // is exactly what happened the first time this was written.
      await sequelize.query(
        'ALTER TABLE "override_reason_codes" ADD COLUMN IF NOT EXISTS "id" UUID DEFAULT gen_random_uuid()', opts
      );
      // Rows that predate the column would otherwise be left null.
      await sequelize.query(
        'UPDATE "override_reason_codes" SET "id" = gen_random_uuid() WHERE "id" IS NULL', opts
      );
      await sequelize.query('ALTER TABLE "override_reason_codes" ALTER COLUMN "id" SET NOT NULL', opts);

      await sequelize.query(
        'ALTER TABLE "override_reason_codes" ADD CONSTRAINT "override_reason_codes_pkey" PRIMARY KEY ("id")', opts
      );

      // A named UNIQUE constraint rather than a plain index: the composite
      // foreign key below has to reference one.
      await sequelize.query(
        'ALTER TABLE "override_reason_codes" DROP CONSTRAINT IF EXISTS "override_reason_codes_tenant_code_unique"', opts
      );
      await sequelize.query(
        `ALTER TABLE "override_reason_codes"
         ADD CONSTRAINT "override_reason_codes_tenant_code_unique" UNIQUE ("tenantId", "code")`, opts
      );

      await sequelize.query(
        `ALTER TABLE "bundle_component_suppressions"
         ADD CONSTRAINT "${FK}"
         FOREIGN KEY ("tenantId", "reasonCode")
         REFERENCES "override_reason_codes" ("tenantId", "code")
         ON DELETE RESTRICT`, opts
      );
    });
  },

  async down(queryInterface) {
    const { sequelize } = queryInterface;

    await sequelize.transaction(async (transaction) => {
      const opts = { transaction };

      await sequelize.query(
        `ALTER TABLE "bundle_component_suppressions" DROP CONSTRAINT IF EXISTS "${FK}"`, opts
      );
      await sequelize.query(
        'ALTER TABLE "override_reason_codes" DROP CONSTRAINT IF EXISTS "override_reason_codes_tenant_code_unique"', opts
      );
      await sequelize.query(
        'ALTER TABLE "override_reason_codes" DROP CONSTRAINT IF EXISTS "override_reason_codes_pkey"', opts
      );
      await sequelize.query('ALTER TABLE "override_reason_codes" DROP COLUMN IF EXISTS "id"', opts);

      // Reverting can only succeed while no two tenants share a code — which is
      // exactly the limitation this migration exists to remove.
      await sequelize.query(
        'ALTER TABLE "override_reason_codes" ADD CONSTRAINT "override_reason_codes_pkey" PRIMARY KEY ("code")', opts
      );
      await sequelize.query(
        `ALTER TABLE "bundle_component_suppressions"
         ADD CONSTRAINT "${FK}" FOREIGN KEY ("reasonCode")
         REFERENCES "override_reason_codes" ("code") ON DELETE RESTRICT`, opts
      );
    });
  },
};
