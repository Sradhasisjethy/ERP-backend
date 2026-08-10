const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');
const { Office } = require('./office.model');

/**
 * Department model representing hierarchical departments.
 */
class Department extends BaseScopedModel {}

Department.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    organizationId: {
      type: DataTypes.UUID,
      allowNull: false,
    },
    officeId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    code: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    parentId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    headId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    status: {
      type: DataTypes.ENUM('active', 'inactive'),
      defaultValue: 'active',
    },
  },
  {
    sequelize,
    tableName: 'departments',
  }
);

Department.belongsTo(Department, { as: 'parentDepartment', foreignKey: 'parentId' });
Department.hasMany(Department, { as: 'subDepartments', foreignKey: 'parentId' });
Department.belongsTo(Office, { foreignKey: 'officeId' });

module.exports = { Department };
