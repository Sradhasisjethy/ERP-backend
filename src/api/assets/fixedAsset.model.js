const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/** A fixed asset and where its depreciation has got to. See the migration for the column meanings. */
class FixedAsset extends BaseAuditedModel {}

FixedAsset.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    factoryId: { type: DataTypes.UUID, allowNull: false },
    assetNumber: { type: DataTypes.STRING, allowNull: false },
    name: { type: DataTypes.STRING(160), allowNull: false },
    category: { type: DataTypes.STRING(80), allowNull: false },
    serialNumber: { type: DataTypes.STRING(80), allowNull: true },
    description: { type: DataTypes.TEXT, allowNull: true },
    acquisitionType: { type: DataTypes.ENUM('PURCHASED', 'EXISTING'), allowNull: false },
    paidFromAccountId: { type: DataTypes.UUID, allowNull: true },
    vendorPartyId: { type: DataTypes.UUID, allowNull: true },
    acquisitionDate: { type: DataTypes.DATEONLY, allowNull: false },
    putToUseDate: { type: DataTypes.DATEONLY, allowNull: false },
    costPaise: { type: DataTypes.BIGINT, allowNull: false },
    salvageValuePaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    method: { type: DataTypes.ENUM('SLM', 'WDV'), allowNull: false },
    usefulLifeMonths: { type: DataTypes.INTEGER, allowNull: true },
    ratePercent: { type: DataTypes.DECIMAL(6, 2), allowNull: true },
    accumulatedDepreciationPaise: { type: DataTypes.BIGINT, allowNull: false, defaultValue: 0 },
    depreciatedUpTo: { type: DataTypes.DATEONLY, allowNull: true },
    status: { type: DataTypes.ENUM('ACTIVE', 'DISPOSED'), allowNull: false, defaultValue: 'ACTIVE' },
    disposedOn: { type: DataTypes.DATEONLY, allowNull: true },
    disposalProceedsPaise: { type: DataTypes.BIGINT, allowNull: true },
    disposalNote: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, tableName: 'fixed_assets' }
);

FixedAsset.belongsTo(Party, { as: 'vendor', foreignKey: 'vendorPartyId' });

/** One depreciation run: a period's charge for every active asset at a factory, posted as one journal. */
class DepreciationRun extends BaseAuditedModel {}

DepreciationRun.initAudited(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    factoryId: { type: DataTypes.UUID, allowNull: false },
    runNumber: { type: DataTypes.STRING, allowNull: false },
    upToDate: { type: DataTypes.DATEONLY, allowNull: false },
    totalPaise: { type: DataTypes.BIGINT, allowNull: false },
    lines: { type: DataTypes.JSONB, allowNull: false },
    status: { type: DataTypes.ENUM('POSTED', 'CANCELLED'), allowNull: false, defaultValue: 'POSTED' },
    cancelReason: { type: DataTypes.TEXT, allowNull: true },
  },
  { sequelize, tableName: 'depreciation_runs' }
);

module.exports = { FixedAsset, DepreciationRun };
