const { DataTypes } = require('sequelize');
const { BaseScopedModel } = require('../../core/BaseModel');
const { sequelize } = require('../../config/database');
const { EmployeeStatus, EmployeeType, SystemRoles } = require('../../utils/constants');

class User extends BaseScopedModel {}

User.initScoped(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    organizationId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    officeId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    departmentId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    // Global uniqueness (not per-tenant) is intentional: login authenticates by
    // email + password alone, with no tenant selector, so two tenants sharing an
    // email would make login ambiguous. Scoping this per-tenant would require the
    // login flow to disambiguate tenants first (e.g. subdomain/slug), which is out
    // of scope here.
    email: {
      type: DataTypes.STRING,
      allowNull: false,
      unique: true,
    },
    passwordHash: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    firstName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    lastName: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    employeeCode: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    phone: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    employeeType: {
      type: DataTypes.ENUM(...Object.values(EmployeeType)),
      defaultValue: EmployeeType.FULL_TIME,
    },
    status: {
      type: DataTypes.ENUM(...Object.values(EmployeeStatus)),
      defaultValue: EmployeeStatus.ONBOARDING,
    },
    isSystem: {
      type: DataTypes.BOOLEAN,
      defaultValue: false,
    },
    managerId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    hrId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    parentId: {
      type: DataTypes.UUID,
      allowNull: true,
    },
    dateOfJoining: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    role: {
      type: DataTypes.ENUM(...Object.values(SystemRoles)),
      defaultValue: SystemRoles.EMPLOYEE,
    },
    avatar: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    resetPasswordToken: {
      type: DataTypes.STRING,
      allowNull: true,
    },
    resetPasswordExpires: {
      type: DataTypes.DATE,
      allowNull: true,
    },
  },
  {
    sequelize,
    tableName: 'employees',
    timestamps: true,
    defaultScope: {
      attributes: { exclude: ['passwordHash'] },
    },
    scopes: {
      withPassword: {
        attributes: { exclude: [] },
      },
    },
  }
);

const { Department } = require('../organization/department.model');
const { Office } = require('../organization/office.model');
const { Organization } = require('../organization/organization.model');

User.belongsTo(User, { as: 'manager', foreignKey: 'managerId' });
User.belongsTo(User, { as: 'hr', foreignKey: 'hrId' });
User.belongsTo(User, { as: 'parent', foreignKey: 'parentId' });
User.hasMany(User, { as: 'directReports', foreignKey: 'managerId' });
User.belongsTo(Department, { foreignKey: 'departmentId' });
User.belongsTo(Office, { foreignKey: 'officeId' });
User.belongsTo(Organization, { foreignKey: 'organizationId' });

module.exports = { User };
