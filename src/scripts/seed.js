const { sequelize } = require('../config/database');
const {
  User,
  Tenant,
  Organization,
  Office,
  Department,
  AdGroup,
  AdGroupMember,
  TenantSettings,
} = require('../models/index');
const bcrypt = require('bcryptjs');
const { EmployeeStatus, EmployeeType, SystemRoles } = require('../utils/constants');

const seedDatabase = async () => {
  try {
    console.log('Starting database seed...');

    // Sync DB
    await sequelize.sync({ force: true });
    console.log('Database synced with force: true');

    // a. 1 Tenant
    const tenant = await Tenant.create({
      name: 'Acme Corporation',
      slug: 'acme-corp',
      status: 'active',
    });
    const tenantId = tenant.get('id');
    console.log(`Created Tenant: ${tenant.get('name')}`);

    // b. 1 Organization
    const org = await Organization.create({
      tenantId,
      name: 'Acme Global',
      code: 'ACM',
      status: 'active',
    });
    const organizationId = org.get('id');
    console.log(`Created Organization: ${org.get('name')}`);

    // c. 3 Offices
    const offices = await Promise.all([
      Office.create({ tenantId, organizationId, name: 'New York HQ', city: 'New York', country: 'USA', status: 'active' }),
      Office.create({ tenantId, organizationId, name: 'London Office', city: 'London', country: 'UK', status: 'active' }),
      Office.create({ tenantId, organizationId, name: 'Bangalore Tech Hub', city: 'Bangalore', country: 'India', status: 'active' }),
    ]);
    console.log(`Created ${offices.length} Offices`);

    // d. 6 Departments
    const departmentsData = [
      { name: 'Engineering', code: 'ENG' },
      { name: 'Product', code: 'PROD' },
      { name: 'Marketing', code: 'MKT' },
      { name: 'Sales', code: 'SALES' },
      { name: 'Human Resources', code: 'HR' },
      { name: 'Finance', code: 'FIN' },
    ];

    const departments = await Promise.all(
      departmentsData.map((d) =>
        Department.create({
          tenantId,
          organizationId,
          name: d.name,
          code: d.code,
          status: 'active',
        })
      )
    );
    console.log(`Created ${departments.length} Departments`);

    // f. 5 Roles (created before employees so the first employee can be assigned one)
    const rolesData = [
      { name: 'Platform Admin', description: 'Full system access', permissions: ['*'] },
      {
        name: 'HR Manager',
        description: 'HR capabilities',
        permissions: ['EMPLOYEE_READ', 'EMPLOYEE_WRITE', 'ORG_READ', 'SETTINGS_READ'],
      },
      {
        name: 'Engineering Lead',
        description: 'Engineering team management',
        permissions: ['EMPLOYEE_READ', 'ORG_READ'],
      },
      { name: 'Employee', description: 'Standard access', permissions: ['EMPLOYEE_READ'] },
      { name: 'Guest', description: 'Limited access', permissions: [] },
    ];

    const roles = await Promise.all(
      rolesData.map((r) =>
        AdGroup.create({
          tenantId,
          name: r.name,
          description: r.description,
          permissions: r.permissions,
          status: 'active',
        })
      )
    );
    console.log(`Created ${roles.length} Roles`);

    // e. 20 Employees
    const names = [
      'John Smith', 'Sarah Johnson', 'Raj Patel', 'Emily Chen', 'Michael Brown',
      'Jessica Davis', 'David Miller', 'Ashley Wilson', 'James Moore', 'Amanda Taylor',
      'Robert Anderson', 'Melissa Thomas', 'William Jackson', 'Stephanie White', 'Joseph Harris',
      'Rebecca Martin', 'Charles Thompson', 'Laura Garcia', 'Thomas Martinez', 'Michelle Robinson',
    ];

    const employees = [];
    for (let i = 0; i < 20; i++) {
      const [firstName, lastName] = names[i].split(' ');
      let status = EmployeeStatus.ACTIVE;
      if (i >= 15 && i < 17) status = EmployeeStatus.ONBOARDING;
      else if (i >= 17 && i < 19) status = EmployeeStatus.TERMINATED;
      else if (i === 19) status = EmployeeStatus.INACTIVE;

      const employee = await User.create(
        {
          tenantId,
          organizationId,
          firstName,
          lastName,
          email: `${firstName.toLowerCase()}.${lastName.toLowerCase()}@acme.corp`,
          employeeCode: `EMP-${String(i + 1).padStart(3, '0')}`,
          employeeType: EmployeeType.FULL_TIME,
          status,
          departmentId: departments[i % departments.length].id,
          officeId: offices[i % offices.length].id,
          passwordHash: await bcrypt.hash('12345678', 10),
          role: i === 0 ? SystemRoles.PLATFORM_ADMIN : SystemRoles.EMPLOYEE,
        },
        { validate: false }
      );
      employees.push(employee);
    }
    console.log(`Created ${employees.length} Employees`);

    // Assign the second employee (a non-bypass role) the "HR Manager" role so the RBAC
    // wiring (JWT permissions <- AdGroupMember -> AdGroup) can be exercised end to end.
    const hrManagerRole = roles.find((r) => r.name === 'HR Manager');
    await AdGroupMember.create({
      tenantId,
      adGroupId: hrManagerRole.id,
      employeeId: employees[1].id,
    });
    console.log(`Assigned "HR Manager" role to ${employees[1].email}`);

    // g. 5 Settings
    const settingsData = [
      { key: 'timezone', value: 'America/New_York', category: 'general' },
      { key: 'dateFormat', value: 'MM/DD/YYYY', category: 'general' },
      { key: 'language', value: 'en', category: 'general' },
      { key: 'sessionTimeout', value: '30', category: 'security' },
      { key: 'passwordMinLength', value: '8', category: 'security' },
    ];

    const settings = await Promise.all(
      settingsData.map((s) =>
        TenantSettings.create({
          tenantId,
          key: s.key,
          value: s.value,
          category: s.category,
        })
      )
    );
    console.log(`Created ${settings.length} Settings`);

    console.log('\n--- Seeding Summary ---');
    console.log(`Tenant: 1`);
    console.log(`Organizations: 1`);
    console.log(`Offices: ${offices.length}`);
    console.log(`Departments: ${departments.length}`);
    console.log(`Employees: ${employees.length}`);
    console.log(`Roles: ${roles.length}`);
    console.log(`Settings: ${settings.length}`);
    console.log('Seeding completed successfully!');

    process.exit(0);
  } catch (error) {
    console.error('Error during seeding:', error);
    process.exit(1);
  }
};

seedDatabase();
