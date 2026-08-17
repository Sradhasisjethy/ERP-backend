const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/database');
const { User } = require('../api/users/user.model');

async function main() {
  const email = process.argv[2];
  const newPassword = process.argv[3];

  if (!email || !newPassword) {
    console.log('\nUsage: node src/scripts/reset-admin-password.js <email> <newPassword>');
    console.log('Example: node src/scripts/reset-admin-password.js john.smith@acme.corp MyNewSecret123\n');
    process.exit(1);
  }

  await sequelize.authenticate();

  const user = await User.findOne({ where: { email } });
  if (!user) {
    console.error(`❌ User with email "${email}" not found.`);
    process.exit(1);
  }

  const hashedPassword = await bcrypt.hash(newPassword, 10);
  await User.update({ passwordHash: hashedPassword }, { where: { id: user.id } });

  console.log(`\n✅ Password successfully updated for Admin: ${user.firstName} ${user.lastName} (${email}) [Role: ${user.role}]\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Error updating password:', err);
  process.exit(1);
});
