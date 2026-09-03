const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/**
 * A pricing list — retail/wholesale general lists, a party-specific list for
 * one customer, or a contractor's piece-rate list (partyType CONTRACTOR).
 * BR-27 masks ratePaise on PriceListItem for users without VIEW_RATES.
 */
class PriceList extends BaseAuditedModel {}

PriceList.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    priceType: {
      type: DataTypes.ENUM('RETAIL', 'WHOLESALE', 'PARTY_SPECIFIC', 'CONTRACTOR_RATE'),
      allowNull: false,
    },
    partyId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    customerTier: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    effectiveFrom: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    validUntil: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    rateBasis: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'TAX_EXCLUSIVE',
    },
    isDefault: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
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
    tableName: 'price_lists',
  }
);

PriceList.belongsTo(Party, { as: 'party', foreignKey: 'partyId' });

module.exports = { PriceList };
