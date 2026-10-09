const bcrypt = require('bcrypt');
const { sequelize } = require('../config/database');
const { User } = require('../api/users/user.model');
const { readPassword, MIN_PASSWORD_LENGTH } = require('./readPassword');
const { authService } = require('../api/auth/auth.service');
const { bumpUser } = require('../utils/permissionVersion');

async function main() {
  const email = process.argv[2];

  if (!email) {
    console.log('\nUsage: node src/scripts/reset-admin-password.js <email> [newPassword]');
    console.log('Leave the password out to be prompted for it.\n');
    process.exit(1);
  }

  const newPassword = await readPassword(process.argv[3], 'New password: ');
  if (!newPassword || newPassword.length < MIN_PASSWORD_LENGTH) {
    console.error(`\nPassword must be at least ${MIN_PASSWORD_LENGTH} characters.\n`);
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
  // Owner and admin accounts cannot use the public reset, so this script is
  // their recovery path — and a recovery that leaves the intruder's sessions
  // alive is not one. Retire every refresh token and every access token.
  await authService.constructor.revokeRefreshTokens({ userId: user.id, reason: 'PASSWORD_RESET' });
  await bumpUser(user.id);

  console.log(`\n✅ Password successfully updated for Admin: ${user.firstName} ${user.lastName} (${email}) [Role: ${user.role}]\n`);
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Error updating password:', err);
  process.exit(1);
});
