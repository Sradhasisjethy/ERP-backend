'use strict';

/**
 * Fixes model/migration drift on `employees.resetPasswordToken` /
 * `resetPasswordExpires`.
 *
 * user.model.js has declared both columns since the forgot-password flow was
 * added, but no migration ever created them. Sequelize lists every declared
 * attribute in the `RETURNING` clause of an INSERT, so against a schema built
 * from the migrations — which is what production runs, and what
 * tests/helpers/db.js builds — *every* insert into `employees` failed with:
 *
 *     column "resetPasswordToken" does not exist
 *
 * That is not limited to password resets: it blocks user creation, the seed
 * script, tenant onboarding and every test file whose fixture creates a user
 * (the whole suite, as it happens). It went unnoticed while tests still built
 * their schema with sync() from the models, where the columns did exist.
 *
 * Added nullable with no default, matching the model exactly.
 */

const addColumnIfMissing = async (queryInterface, table, column, spec) => {
  const described = await queryInterface.describeTable(table);
  if (!described[column]) await queryInterface.addColumn(table, column, spec);
};

module.exports = {
  async up(queryInterface, Sequelize) {
    const tables = await queryInterface.showAllTables();
    if (!tables.includes('employees')) return;

    await addColumnIfMissing(queryInterface, 'employees', 'resetPasswordToken', {
      type: Sequelize.STRING,
      allowNull: true,
    });
    await addColumnIfMissing(queryInterface, 'employees', 'resetPasswordExpires', {
      type: Sequelize.DATE,
      allowNull: true,
    });
  },

  async down(queryInterface) {
    await queryInterface.removeColumn('employees', 'resetPasswordExpires').catch(() => {});
    await queryInterface.removeColumn('employees', 'resetPasswordToken').catch(() => {});
  },
};
