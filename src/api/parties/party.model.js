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
