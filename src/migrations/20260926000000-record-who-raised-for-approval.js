'use strict';

/**
 * Who raised it, so approval can refuse the person who did.
 *
 * "Approval is separate from doing" is stated as a rule in
 * constants/defaultRoles.js and enforced properly in exactly one place —
 * HrService.decideLeave, which refuses a decider who is the applicant. The two
 * other approval flows could not enforce it even in principle, because neither
 * record stored who created it:
 *
 *   purchase_indents        has `approvedBy`, no `requestedBy`
 *   material_consumptions   has `approvedBy`, no `recordedBy`
 *
 * So anyone holding both grants could raise and approve their own indent, and
 * for production variance that is the *default* configuration: the seeded
 * "Production Supervisor" role holds PRODUCTION_CREATE and
 * PRODUCTION_APPROVE_VARIANCE together.
 *
 * Nullable, with no backfill. Rows written before this migration genuinely have
 * no recorded author, and inventing one — by guessing from the audit log, or by
 * attributing them to whoever runs the migration — would put a false name
 * against a real approval. A null author means "unknown", and the guard treats
 * unknown as "cannot prove self-approval", which is the honest reading: it does
 * not retroactively block historical records it has no evidence about.
 */
const AUTHOR_COLUMN = {
  purchase_indents: 'requestedBy',
  material_consumptions: 'recordedBy',
};

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const [table, column] of Object.entries(AUTHOR_COLUMN)) {
      const described = await queryInterface.describeTable(table);
      if (described[column]) continue;

      await queryInterface.addColumn(table, column, {
        type: Sequelize.UUID,
        allowNull: true,
        references: { model: 'employees', key: 'id' },
        // The author is history. Deleting the employee must not delete the
        // indent, nor quietly reassign it.
        onDelete: 'SET NULL',
        onUpdate: 'CASCADE',
      });
    }
  },

  async down(queryInterface) {
    for (const [table, column] of Object.entries(AUTHOR_COLUMN)) {
      await queryInterface.removeColumn(table, column).catch(() => {});
    }
  },
};
