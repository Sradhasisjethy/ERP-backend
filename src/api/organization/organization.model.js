const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');

/**
 * Organization model representing a company/entity within a tenant.
 */
class Organization extends BaseAuditedModel {}

Organization.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    // `name` is the legal name — the one registered against the GSTIN and
    // printed on tax invoices. `tradeName` is what the business trades as
    // (shop board, letterhead); GST rules allow the two to differ, and both
    // appear on a GST invoice when they do.
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    tradeName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    gstin: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    // Statutory identifiers, first-class columns rather than keys in
    // `settings`: invoice/e-way/e-invoice payload builders read them by name.
    pan: {
      type: DataTypes.STRING(10),
      allowNull: true,
    },
    cin: {
      type: DataTypes.STRING(21),
      allowNull: true,
    },
    // MSME / Udyam registration, format UDYAM-XX-00-0000000.
    udyam: {
      type: DataTypes.STRING(20),
      allowNull: true,
    },
    // Registered address — the one that renders on GST invoice headers. The
    // PIN code also feeds e-Way Bill distance calculation (NIC APIs).
    addressLine1: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    addressLine2: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    city: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    state: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // GST state code (two digits, e.g. 21 = Odisha). Kept beside the state
    // name because place-of-supply logic works on codes, not spellings.
    stateCode: {
      type: DataTypes.STRING(2),
      allowNull: true,
    },
    pinCode: {
      type: DataTypes.STRING(6),
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    phone: {
      type: DataTypes.STRING(16),
      allowNull: true,
    },
    // STRING rather than a pg ENUM on purpose: an ISO 4217 code covers the
    // multi-currency (import/export) case without a migration per currency.
    baseCurrency: {
      type: DataTypes.STRING(3),
      allowNull: false,
      defaultValue: 'INR',
    },
    // APRIL = Indian fiscal year (April–March); JANUARY = calendar year.
    // STRING + isIn instead of a pg ENUM so the migration stays a plain
    // addColumn and adding a cycle later is not a type migration.
    fiscalYearStart: {
      type: DataTypes.STRING(10),
      allowNull: false,
      defaultValue: 'APRIL',
      validate: { isIn: [['APRIL', 'JANUARY']] },
    },
    // Default bank account — optional at creation, required by the invoice
    // templates that print remittance details.
    bankName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    bankBranch: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    bankAccountNumber: {
      type: DataTypes.STRING(18),
      allowNull: true,
    },
    bankIfsc: {
      type: DataTypes.STRING(11),
      allowNull: true,
    },
    // A path issued by POST /organizations/logo, same contract as user
    // avatars: the schema only accepts paths this API handed out.
    logo: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    description: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('active', 'inactive'),
      defaultValue: 'active',
    },
    settings: {
      type: DataTypes.JSONB,
      defaultValue: {},
    },
  },
  {
    sequelize,
    // D2: optimistic locking — a save from a stale form is rejected
    // rather than silently overwriting a concurrent edit.
    version: 'lockVersion',
    tableName: 'organizations',
  }
);

module.exports = { Organization };
