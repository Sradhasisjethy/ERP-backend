'use strict';

/**
 * The Add Organisation form grew the Indian statutory company profile: legal
 * vs trade name, PAN/CIN/Udyam, the registered address (PIN code feeds e-Way
 * Bill distance calculation), official contact, base currency and fiscal year
 * cycle, default bank details for invoice templates, and the logo path that
 * renders on GST invoices, challans, BOM printouts and POs.
 *
 * IF-missing guards because the dev database predates migrations (built by
 * sync()) and may already carry some columns.
 */
const addColumnIfMissing = async (queryInterface, table, column, spec) => {
  const described = await queryInterface.describeTable(table);
  if (!described[column]) await queryInterface.addColumn(table, column, spec);
};

const COLUMNS = (Sequelize) => ({
  tradeName: { type: Sequelize.STRING, allowNull: true },
  pan: { type: Sequelize.STRING(10), allowNull: true },
  cin: { type: Sequelize.STRING(21), allowNull: true },
  udyam: { type: Sequelize.STRING(20), allowNull: true },
  addressLine1: { type: Sequelize.STRING, allowNull: true },
  addressLine2: { type: Sequelize.STRING, allowNull: true },
  city: { type: Sequelize.STRING, allowNull: true },
  state: { type: Sequelize.STRING, allowNull: true },
  stateCode: { type: Sequelize.STRING(2), allowNull: true },
  pinCode: { type: Sequelize.STRING(6), allowNull: true },
  email: { type: Sequelize.STRING, allowNull: true },
  phone: { type: Sequelize.STRING(16), allowNull: true },
  // NOT NULL with a default so every existing row answers "what currency /
  // which fiscal cycle" without the readers null-checking.
  baseCurrency: { type: Sequelize.STRING(3), allowNull: false, defaultValue: 'INR' },
  fiscalYearStart: { type: Sequelize.STRING(10), allowNull: false, defaultValue: 'APRIL' },
  bankName: { type: Sequelize.STRING, allowNull: true },
  bankBranch: { type: Sequelize.STRING, allowNull: true },
  bankAccountNumber: { type: Sequelize.STRING(18), allowNull: true },
  bankIfsc: { type: Sequelize.STRING(11), allowNull: true },
  logo: { type: Sequelize.STRING(255), allowNull: true },
});

module.exports = {
  async up(queryInterface, Sequelize) {
    for (const [column, spec] of Object.entries(COLUMNS(Sequelize))) {
      await addColumnIfMissing(queryInterface, 'organizations', column, spec);
    }
  },

  async down(queryInterface, Sequelize) {
    for (const column of Object.keys(COLUMNS(Sequelize))) {
      await queryInterface.removeColumn('organizations', column).catch(() => {});
    }
  },
};
