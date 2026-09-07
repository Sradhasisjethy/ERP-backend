const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');

/**
 * Unified business-partner record for Customer/Vendor/Contractor/Labour/Sales
 * Reference (BRD M04). Modelled as one table with a partyType discriminator —
 * these five roles share the same core identity fields (name, address, GSTIN,
 * contact), and a single Party can plausibly be more than one role (a
 * customer who is also a supplier). Type-specific data that doesn't fit the
 * shared shape (piece rates, daily wages) lives in small extension tables
 * (see labourWageProfile.model.js) rather than being bolted onto this one.
 */
class Party extends BaseAuditedModel {}

Party.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    partyType: {
      type: DataTypes.ENUM('CUSTOMER', 'VENDOR', 'CONTRACTOR', 'LABOUR', 'SALES_REF'),
      allowNull: false,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    gstin: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    email: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    address: {
      type: DataTypes.TEXT,
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
    country: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'India',
    },
    gstType: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    legalName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // Customer and Vendor fields
    openingBalance: {
      type: DataTypes.DECIMAL(15, 2),
      allowNull: true,
      defaultValue: 0,
    },
    asOfDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    paymentTerms: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    pincode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    billingAddress: {
      type: DataTypes.TEXT,
      allowNull: true,
    },
    creditPeriodDays: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
    noOfCredits: {
      type: DataTypes.INTEGER,
      allowNull: true,
      defaultValue: 0,
    },
    relationshipSince: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    distanceKm: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
    },
    transportation: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    balanceType: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'TO_PAY',
    },
    // Vendor Statutory & Compliance fields
    pan: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    msmeCategory: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'NONE',
    },
    udyamNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    tdsApplicable: {
      type: DataTypes.BOOLEAN,
      allowNull: false,
      defaultValue: false,
    },
    tdsSection: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // Vendor Banking Details
    bankAccountNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    bankIfsc: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    bankName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    bankBranch: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    beneficiaryName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    // Contractor Statutory & Labor Compliance fields
    pfCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    esicNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    laborLicenseNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    workCategory: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    retentionPercent: {
      type: DataTypes.DECIMAL(5, 2),
      allowNull: true,
      defaultValue: 0,
    },
    entityType: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'INDIVIDUAL',
    },
    // Labour Specific Identity, Skill, & Payout fields
    aadhaarNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    emergencyContactName: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    emergencyContactPhone: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    badgeNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    skillCategory: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    wageBasis: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'DAILY_RATE',
    },
    contractorId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    paymentMode: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'BANK_TRANSFER',
    },
    uanNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    esicIpNumber: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    dateOfBirth: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    gender: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'MALE',
    },
    // Sales Reference (Broker/Agent) Commission Fields
    commissionType: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: 'PERCENTAGE',
    },
    commissionValue: {
      type: DataTypes.DECIMAL(10, 2),
      allowNull: true,
      defaultValue: 0,
    },
    // BR-13: a customer exceeding creditLimitPaise or with overdue invoices
    // beyond creditAgeingDays triggers creditAction on new orders. Meaningful
    // for partyType CUSTOMER; left at defaults for other types.
    creditLimitPaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
      defaultValue: 0,
    },
    creditAgeingDays: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 0,
    },
    creditAction: {
      type: DataTypes.ENUM('NONE', 'WARN', 'BLOCK'),
      allowNull: false,
      defaultValue: 'NONE',
    },
    status: {
      type: DataTypes.ENUM('active', 'inactive'),
      defaultValue: 'active',
    },
  },
  {
    sequelize,
    // D2: optimistic locking — a save from a stale form is rejected
    // rather than silently overwriting a concurrent edit.
    version: 'lockVersion',
    tableName: 'parties',
  }
);

module.exports = { Party };
