const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { Party } = require('../parties/party.model');

/**
 * BR-23: material issued to a contractor for job work remains BPL stock,
 * tracked in a separate "With Contractor" location — this moves a lot from
 * normal factory AVAILABLE stock into a new lot with status WITH_CONTRACTOR
 * (workforce.service.js#issueMaterialToContractor), never off the books.
 */
class ContractorMaterialIssue extends BaseAuditedModel {}

ContractorMaterialIssue.initAudited(
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
    issueNumber: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    contractorPartyId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    issueDate: {
      type: DataTypes.DATEONLY,
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
    tableName: 'contractor_material_issues',
  }
);

ContractorMaterialIssue.belongsTo(Party, { as: 'contractor', foreignKey: 'contractorPartyId' });

module.exports = { ContractorMaterialIssue };
