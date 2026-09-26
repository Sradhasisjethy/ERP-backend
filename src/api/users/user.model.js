const { DataTypes } = require('sequelize');
const { BaseAuditedModel } = require('../../core/AuditedModel');
const { sequelize } = require('../../config/database');
const { EmployeeStatus, EmployeeType, SystemRoles } = require('../../utils/constants');

/**
 * Audited: `users.role` decides whether a session bypasses every permission
 * check in the application (middlewares/authorize.js), so a change to it is a
 * privilege change and has to be attributable. Secrets are excluded from the
 * snapshots below — an audit row must never become a second place the password
 * hash or a live reset token is stored.
 */
class User extends BaseAuditedModel {}

User.initAudited(
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
    },
    pincode: {
      type: DataTypes.STRING(20),
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
    resignationDate: {
      type: DataTypes.DATEONLY,
      allowNull: true,
    },
    gender: {
      type: DataTypes.STRING(50),
      allowNull: true,
    },
    assetName: {
      type: DataTypes.STRING(255),
      allowNull: true,
    },
    assetCode: {
      type: DataTypes.STRING(100),
      allowNull: true,
    },
    role: {
      type: DataTypes.ENUM(...Object.values(SystemRoles)),
      defaultValue: SystemRoles.EMPLOYEE,
    },
    avatar: {
      type: DataTypes.TEXT,
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
    /**
     * Bumped whenever this user's effective permissions change. The access
     * token carries the value it was minted with, and `authenticate` refuses a
     * token whose claim is behind this — see utils/permissionVersion.js.
     */
    permissionsVersion: {
      type: DataTypes.INTEGER,
      allowNull: false,
      defaultValue: 1,
    },
  },
  {
    sequelize,
    tableName: 'employees',
    timestamps: true,
    // Never let an audit row become a second place a credential is stored. The
    // point of auditing this model is the `role` column, not the secrets.
    auditExclude: ['passwordHash', 'resetPasswordToken', 'resetPasswordExpires'],
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

/**
 * Any write to a user row may change what `authenticate` would answer for
 * them — status above all — so the cached answer goes with it. The bulk forms
 * do not say which rows they touched, so they drop every entry; they are rare
 * and the cost is one lookup per active user. See core/sessionStateCache.js.
 */
const { sessionStateCache } = require('../../core/sessionStateCache');
User.addHook('afterUpdate', (user, options) => sessionStateCache.invalidate(user.id, options?.transaction));
User.addHook('afterDestroy', (user, options) => sessionStateCache.invalidate(user.id, options?.transaction));
User.addHook('afterBulkUpdate', (options) => sessionStateCache.clear(options?.transaction));
User.addHook('afterBulkDestroy', (options) => sessionStateCache.clear(options?.transaction));

module.exports = { User };
