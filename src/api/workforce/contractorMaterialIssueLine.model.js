const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { ContractorMaterialIssue } = require('./contractorMaterialIssue.model');
const { Product } = require('../products/product.model');
const { StockLot } = require('../inventory/stockLot.model');

class ContractorMaterialIssueLine extends BaseAuditedModel {}

ContractorMaterialIssueLine.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    contractorMaterialIssueId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    productId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    quantity: {
      type: DataTypes.DECIMAL(14, 4),
      allowNull: false,
    },
    createdLotId: {
      // The new WITH_CONTRACTOR lot this issue created.
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'contractor_material_issue_lines',
  }
);

ContractorMaterialIssueLine.belongsTo(ContractorMaterialIssue, { as: 'issue', foreignKey: 'contractorMaterialIssueId' });
ContractorMaterialIssueLine.belongsTo(Product, { as: 'product', foreignKey: 'productId' });
ContractorMaterialIssueLine.belongsTo(StockLot, { as: 'createdLot', foreignKey: 'createdLotId' });
ContractorMaterialIssue.hasMany(ContractorMaterialIssueLine, { as: 'lines', foreignKey: 'contractorMaterialIssueId' });

module.exports = { ContractorMaterialIssueLine };
