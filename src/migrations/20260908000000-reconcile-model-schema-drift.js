'use strict';

/**
 * Closes the drift between the models and the migration-built schema.
 *
 * WHY THIS EXISTS
 * ---------------
 * tests/helpers/db.js made migrations the single source of truth for the test
 * schema, but the databases in use had been built earlier by `sequelize.sync()`
 * and already carried these columns. So master-data fields added to models over
 * the last several phases (the expanded party master, the vehicle compliance
 * fields, opening stock on products, the price-list validity window, and
 * `financial_years.status`, which factory.service.js writes on year rollover)
 * never got a migration and nobody noticed: every test run passed against a
 * database that no migration could reproduce.
 *
 * A database built purely from migrations was therefore missing 90 columns
 * across 11 tables and could not run the application — `FinancialYear.create`
 * failed outright. This migration adds exactly those columns, with the types
 * taken from the models.
 *
 * Each column is added only if absent. That is deliberate rather than lazy: the
 * databases this migration is most needed on are the sync-built ones that
 * already have some of these columns, and it must not fail halfway through
 * repairing them.
 */

/** Types match the model definitions; see the header for why they were missing. */
const COLUMNS = (S) => ({
  departments: {
    officeId: { type: S.UUID, allowNull: true, references: { model: 'offices', key: 'id' }, onDelete: 'SET NULL' },
  },

  employee_documents: {
    isVerified: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
  },

  financial_years: {
    // factory.service.js sets SOFT_CLOSED on rollover; without this column that
    // write throws on any freshly migrated database.
    status: { type: S.ENUM('PLANNED', 'ACTIVE', 'SOFT_CLOSED', 'CLOSED'), allowNull: false, defaultValue: 'PLANNED' },
  },

  uoms: {
    // Unit Quantity Code — the GST portal's own vocabulary (NOS, MTR, KGS),
    // which is not always what the plant calls the unit.
    uqc: { type: S.STRING(20), allowNull: true },
  },

  hsn_codes: {
    codeType: { type: S.STRING(10), allowNull: false, defaultValue: 'HSN' },
    cessPercent: { type: S.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
  },

  products: {
    sellingPricePaise: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
    openingStockQty: { type: S.DECIMAL(14, 4), allowNull: true, defaultValue: 0 },
    openingStockRatePaise: { type: S.BIGINT, allowNull: true, defaultValue: 0 },
    openingStockDate: { type: S.DATEONLY, allowNull: true },
    defaultLocation: { type: S.STRING(100), allowNull: true },
  },

  mix_designs: {
    laborCostPaise: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
    overheadCostPaise: { type: S.BIGINT, allowNull: false, defaultValue: 0 },
  },

  price_lists: {
    customerTier: { type: S.STRING(50), allowNull: true },
    effectiveFrom: { type: S.DATEONLY, allowNull: true },
    validUntil: { type: S.DATEONLY, allowNull: true },
    rateBasis: { type: S.STRING(20), allowNull: false, defaultValue: 'TAX_EXCLUSIVE' },
  },

  price_list_items: {
    minQuantity: { type: S.DECIMAL(14, 4), allowNull: false, defaultValue: 1 },
    discountPercent: { type: S.DECIMAL(5, 2), allowNull: false, defaultValue: 0 },
  },

  vehicles: {
    tareWeightTonnes: { type: S.DECIMAL(10, 3), allowNull: true },
    grossVehicleWeightTonnes: { type: S.DECIMAL(10, 3), allowNull: true },
    bodyConfiguration: { type: S.STRING(50), allowNull: true },
    driverLicenseNumber: { type: S.STRING(50), allowNull: true },
    puccExpiry: { type: S.DATEONLY, allowNull: true },
    fastagNumber: { type: S.STRING(50), allowNull: true },
    gpsDeviceId: { type: S.STRING(100), allowNull: true },
    blacklistReason: { type: S.TEXT, allowNull: true },
  },

  // The party master carries customers, suppliers, transporters, contractors and
  // labour on one table, which is why this list is long: each persona brought
  // its own statutory and payroll fields.
  parties: {
    gstType: { type: S.STRING(50), allowNull: true },
    legalName: { type: S.STRING(255), allowNull: true },
    openingBalance: { type: S.DECIMAL(15, 2), allowNull: true, defaultValue: 0 },
    asOfDate: { type: S.DATEONLY, allowNull: true },
    paymentTerms: { type: S.STRING(50), allowNull: true },
    pincode: { type: S.STRING(20), allowNull: true },
    billingAddress: { type: S.TEXT, allowNull: true },
    creditPeriodDays: { type: S.INTEGER, allowNull: true, defaultValue: 0 },
    noOfCredits: { type: S.INTEGER, allowNull: true, defaultValue: 0 },
    relationshipSince: { type: S.STRING(50), allowNull: true },
    distanceKm: { type: S.DECIMAL(10, 2), allowNull: true },
    transportation: { type: S.STRING(255), allowNull: true },
    balanceType: { type: S.STRING(20), allowNull: true, defaultValue: 'TO_PAY' },

    pan: { type: S.STRING(10), allowNull: true },
    msmeCategory: { type: S.STRING(20), allowNull: true, defaultValue: 'NONE' },
    udyamNumber: { type: S.STRING(50), allowNull: true },
    tdsApplicable: { type: S.BOOLEAN, allowNull: false, defaultValue: false },
    tdsSection: { type: S.STRING(50), allowNull: true },

    bankAccountNumber: { type: S.STRING(50), allowNull: true },
    bankIfsc: { type: S.STRING(20), allowNull: true },
    bankName: { type: S.STRING(100), allowNull: true },
    bankBranch: { type: S.STRING(100), allowNull: true },
    beneficiaryName: { type: S.STRING(255), allowNull: true },
    paymentMode: { type: S.STRING(30), allowNull: true, defaultValue: 'BANK_TRANSFER' },

    pfCode: { type: S.STRING(50), allowNull: true },
    esicNumber: { type: S.STRING(50), allowNull: true },
    laborLicenseNumber: { type: S.STRING(50), allowNull: true },
    workCategory: { type: S.STRING(100), allowNull: true },
    retentionPercent: { type: S.DECIMAL(5, 2), allowNull: true, defaultValue: 0 },
    entityType: { type: S.STRING(30), allowNull: true, defaultValue: 'INDIVIDUAL' },

    aadhaarNumber: { type: S.STRING(20), allowNull: true },
    emergencyContactName: { type: S.STRING(100), allowNull: true },
    emergencyContactPhone: { type: S.STRING(30), allowNull: true },
    badgeNumber: { type: S.STRING(50), allowNull: true },
    skillCategory: { type: S.STRING(50), allowNull: true },
    wageBasis: { type: S.STRING(50), allowNull: true, defaultValue: 'DAILY_RATE' },
    contractorId: { type: S.UUID, allowNull: true, references: { model: 'parties', key: 'id' }, onDelete: 'SET NULL' },
    uanNumber: { type: S.STRING(50), allowNull: true },
    esicIpNumber: { type: S.STRING(50), allowNull: true },
    dateOfBirth: { type: S.DATEONLY, allowNull: true },
    gender: { type: S.STRING(20), allowNull: true, defaultValue: 'MALE' },

    commissionType: { type: S.STRING(50), allowNull: true, defaultValue: 'PERCENTAGE' },
    commissionValue: { type: S.DECIMAL(10, 2), allowNull: true, defaultValue: 0 },
  },
});

module.exports = {
  async up(queryInterface, Sequelize) {
    const spec = COLUMNS(Sequelize);

    for (const [table, columns] of Object.entries(spec)) {
      const existing = await queryInterface.describeTable(table);
      for (const [name, definition] of Object.entries(columns)) {
        if (existing[name]) continue;
        await queryInterface.addColumn(table, name, definition);
      }
    }
  },

  async down(queryInterface, Sequelize) {
    const spec = COLUMNS(Sequelize);

    for (const [table, columns] of Object.entries(spec)) {
      const existing = await queryInterface.describeTable(table);
      for (const name of Object.keys(columns)) {
        if (!existing[name]) continue;
        await queryInterface.removeColumn(table, name);
      }
    }

    // Sequelize creates a backing type for an ENUM column and does not drop it
    // with the column, so a re-run of up() would hit a type that already exists.
    await queryInterface.sequelize.query('DROP TYPE IF EXISTS "enum_financial_years_status";');
  },
};
