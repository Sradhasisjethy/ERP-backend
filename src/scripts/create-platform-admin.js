const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/database');
const { User, Tenant, Organization } = require('../models');
const { SystemRoles, EmployeeStatus, EmployeeType } = require('../utils/constants');

async function main() {
  const email = process.argv[2];
  const password = process.argv[3];
  const firstName = process.argv[4] || 'Admin';
  const lastName = process.argv[5] || 'User';

  if (!email || !password) {
    console.log('\nUsage: node src/scripts/create-platform-admin.js <email> <password> [firstName] [lastName]');
    console.log('Example: node src/scripts/create-platform-admin.js rogers@shield.com 9988 Rogers Shield\n');
    process.exit(1);
  }

  if (!email.includes('@')) {
    console.error('\n❌ Invalid Email Format! Email must contain "@" (e.g. rogers@shield.com)\n');
    process.exit(1);
  }

  await sequelize.authenticate();

  const tenant = await Tenant.findOne();
  const org = await Organization.findOne();

  if (!tenant || !org) {
    console.error('❌ Tenant or Organization missing. Please run seed script first.');
    process.exit(1);
  }

  const existingUser = await User.findOne({ where: { email } });
  if (existingUser) {
    console.error(`❌ User with email "${email}" already exists.`);
    process.exit(1);
  }

  const hashedPassword = await bcrypt.hash(password, 10);
  const adminCode = `ADM-${Math.floor(1000 + Math.random() * 9000)}`;

  const newAdmin = await User.create({
    tenantId: tenant.id,
    organizationId: org.id,
    email,
    passwordHash: hashedPassword,
    firstName,
    lastName,
    employeeCode: adminCode,
    employeeType: EmployeeType.FULL_TIME,
    status: EmployeeStatus.ACTIVE,
    isSystem: true,
    role: SystemRoles.PLATFORM_ADMIN,
  });

  console.log(`\n✅ Platform Admin successfully created!`);
  console.log(`-------------------------------------------`);
  console.log(`Name:     ${newAdmin.firstName} ${newAdmin.lastName}`);
  console.log(`Email:    ${newAdmin.email}`);
  console.log(`Role:     ${newAdmin.role}`);
  console.log(`Code:     ${newAdmin.employeeCode}`);
  console.log(`-------------------------------------------\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Error creating Platform Admin:', err);
  process.exit(1);
});
