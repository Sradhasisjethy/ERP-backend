const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');
const { Product } = require('../products/product.model');
const { MixDesign } = require('../products/mixDesign.model');
const { StockLot } = require('../inventory/stockLot.model');

/**
 * BR-22: "Contractor production entry values output at the agreed piece
 * rate, credits the contractor ledger, and creates finished stock in the
 * same transaction — all three or none." All three happen inside a single
 * DB transaction in workforce.service.js#createContractorProductionEntry.
 */
class ContractorProductionEntry extends BaseAuditedModel {}

ContractorProductionEntry.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    factoryId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    entryNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    contractorPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    mixDesignId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productionDate: {
      type: DataTypes.DATEONLY,
      allowNull: false,
    },
    quantity: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    pieceRatePaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    totalValuePaise: {
      type: DataTypes.BIGINT,
      allowNull: false,
    },
    curingDays: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    lotId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    status: {
      type: DataTypes.ENUM('POSTED', 'CANCELLED'),
      allowNull: false,
      defaultValue: 'POSTED',
    },
  },
  {
    sequelize,
    tableName: 'contractor_production_entries',
  }
);

ContractorProductionEntry.belongsTo(Party, { as: 'contractor', foreignKey: 'contractorPartyId' });
ContractorProductionEntry.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
ContractorProductionEntry.belongsTo(MixDesign, { as: 'mixDesign', foreignKey: 'mixDesignId' });
ContractorProductionEntry.belongsTo(StockLot, { as: 'lot', foreignKey: 'lotId' });

module.exports = { ContractorProductionEntry };
