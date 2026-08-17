const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('./party.model');

/**
 * FR-M04-2: a party may have many addresses, each flagged billing and/or
 * shipping, with one default of each kind.
 *
 * `stateCode` is the load-bearing field: GST place of supply is determined from
 * the **shipping** address's state code versus the supplying factory's, never
 * from the customer's head-office state (FR-M16-4, AC-9.1). A Delhi-registered
 * customer taking delivery in Odisha is an intra-state supply, and getting that
 * backwards misfiles the return.
 */
class PartyAddress extends BaseAuditedModel {}

PartyAddress.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    partyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    label: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'Main',
    },
    contactPerson: { type: DataTypes.STRING, allowNull: true },
    phone: { type: DataTypes.STRING, allowNull: true },
    line1: { type: DataTypes.STRING, allowNull: false },
    line2: { type: DataTypes.STRING, allowNull: true },
    city: { type: DataTypes.STRING, allowNull: true },
    state: { type: DataTypes.STRING, allowNull: true },
    // Two-digit GST state code (Odisha = 21, Delhi = 07). Kept alongside the
    // human-readable state name because tax logic must compare codes, not
    // free text where "Odisha"/"ODISHA"/"Orissa" would all fail to match.
    stateCode: { type: DataTypes.STRING(2), allowNull: true },
    pincode: { type: DataTypes.STRING, allowNull: true },
    country: { type: DataTypes.STRING, allowNull: true, defaultValue: 'India' },
    gstin: { type: DataTypes.STRING, allowNull: true },

    isBilling: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isShipping: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: true },
    isDefaultBilling: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },
    isDefaultShipping: { type: DataTypes.BOOLEAN, allowNull: false, defaultValue: false },

    status: { type: DataTypes.ENUM('active', 'inactive'), defaultValue: 'active' },
  },
  {
    sequelize,
    // D2: optimistic locking — a save from a stale form is rejected
    // rather than silently overwriting a concurrent edit.
    version: 'lockVersion',
    tableName: 'party_addresses',
  }
);

PartyAddress.belongsTo(Party, { as: 'party', foreignKey: 'partyId' });
Party.hasMany(PartyAddress, { as: 'addresses', foreignKey: 'partyId' });

module.exports = { PartyAddress };
