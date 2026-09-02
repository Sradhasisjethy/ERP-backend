const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');

/**
 * Junction model mapping Offices to Departments in a Many-to-Many relationship.
 */
class OfficeDepartment extends BaseAuditedModel {}

OfficeDepartment.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    tenantId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    officeId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    departmentId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
  },
  {
    sequelize,
    tableName: 'office_departments',
    indexes: [
      {
        unique: true,
        fields: ['officeId', 'departmentId'],
      },
    ],
  }
);

module.exports = { OfficeDepartment };
