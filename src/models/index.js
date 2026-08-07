const { User } = require('../api/users/user.model');
const { Tenant } = require('../api/organization/tenant.model');
const { Organization } = require('../api/organization/organization.model');
const { Office } = require('../api/organization/office.model');
const { Department } = require('../api/organization/department.model');
const { AdGroup } = require('../api/roles/role.model');
const { AdGroupMember } = require('../api/roles/adGroupMember.model');
const { TenantSettings } = require('../api/settings/settings.model');

// Tenant associations
Tenant.hasMany(Organization, { foreignKey: 'tenantId' });
Organization.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(Office, { foreignKey: 'tenantId' });
Office.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(Department, { foreignKey: 'tenantId' });
Department.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(User, { foreignKey: 'tenantId' });
User.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(AdGroup, { foreignKey: 'tenantId' });
AdGroup.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(AdGroupMember, { foreignKey: 'tenantId' });
AdGroupMember.belongsTo(Tenant, { foreignKey: 'tenantId' });

Tenant.hasMany(TenantSettings, { foreignKey: 'tenantId' });
TenantSettings.belongsTo(Tenant, { foreignKey: 'tenantId' });

// Organization associations
Organization.hasMany(Office, { foreignKey: 'organizationId' });

Organization.hasMany(Department, { foreignKey: 'organizationId' });
Department.belongsTo(Organization, { foreignKey: 'organizationId' });

Organization.hasMany(User, { foreignKey: 'organizationId' });
User.belongsTo(Organization, { foreignKey: 'organizationId' });

// Office associations
Office.hasMany(User, { foreignKey: 'officeId' });
User.belongsTo(Office, { foreignKey: 'officeId' });

// Department associations
Department.hasMany(User, { foreignKey: 'departmentId' });
User.belongsTo(Department, { foreignKey: 'departmentId' });

// AdGroupMember associations
User.hasMany(AdGroupMember, { foreignKey: 'employeeId' });
AdGroupMember.belongsTo(User, { foreignKey: 'employeeId' });

module.exports = {
  User,
  Tenant,
  Organization,
  Office,
  Department,
  AdGroup,
  AdGroupMember,
  TenantSettings,
};
