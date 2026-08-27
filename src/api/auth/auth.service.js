const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { User } = require('../users/user.model');
const { AdGroup } = require('../roles/role.model');
const { AdGroupMember } = require('../roles/adGroupMember.model');
const { env } = require('../../config/env');
const { UnauthorizedError, NotFoundError, BadRequestError } = require('../../core/AppError');
const { expandPermissions } = require('../../utils/permissionCatalog');
const emailService = require('../../services/email.service');
const { WebPermissions, SystemRoles, EmployeeStatus } = require('../../utils/constants');

class AuthService {
  /**
   * Aggregates the permissions granted to a user through their system role
   * and all active AdGroups (roles) they're a member of.
   */
  async getPermissionsForUser(userId, role) {
    const permissions = new Set();

    // Default role-based permissions
    if ([SystemRoles.PLATFORM_ADMIN, SystemRoles.TENANT_OWNER, SystemRoles.ORG_ADMIN].includes(role)) {
      Object.values(WebPermissions).forEach((p) => permissions.add(p));
    } else if (role === SystemRoles.HR_ADMIN) {
      permissions.add(WebPermissions.EMPLOYEE_READ);
      permissions.add(WebPermissions.EMPLOYEE_WRITE);
      permissions.add(WebPermissions.ORG_READ);
      permissions.add(WebPermissions.ROLE_READ);
    } else if (role === SystemRoles.MANAGER) {
      permissions.add(WebPermissions.EMPLOYEE_READ);
      permissions.add(WebPermissions.ORG_READ);
    }

    if (userId) {
      const memberships = await AdGroupMember.findAll({
        where: { employeeId: userId },
        include: [{ model: AdGroup, attributes: ['permissions', 'status'] }],
      });

      for (const membership of memberships) {
        const group = membership.AdGroup;
        if (group && group.status === 'active' && Array.isArray(group.permissions)) {
          group.permissions.forEach((permission) => permissions.add(permission));
        }
      }
    }

    return expandPermissions(Array.from(permissions));
  }

  async generateAccessToken(user) {
    const permissions = await this.getPermissionsForUser(user.id, user.role);
    return jwt.sign(
      {
        userId: user.id,
        tenantId: user.tenantId,
        organizationId: user.organizationId,
        role: user.role,
        permissions,
      },
      env.JWT_SECRET,
      { expiresIn: '15m', algorithm: 'HS256' }
    );
  }

  generateRefreshToken(userId) {
    return jwt.sign({ userId }, env.JWT_REFRESH_SECRET, {
      expiresIn: '7d',
      algorithm: 'HS256',
    });
  }

  /**
   * A user may sign in only while their account is active.
   *
   * Nothing checked this. A TERMINATED or INACTIVE employee could log in
   * normally, and — worse — anyone already holding a 7-day refresh token kept
   * minting fresh 15-minute access tokens for a week after being disabled,
   * because `refresh()` only verified the signature and that the row still
   * existed. Disabling an account was, in practice, advisory.
   *
   * The message is deliberately the same as a bad password: telling an attacker
   * "that account exists but is disabled" is still telling them the account
   * exists.
   */
  static assertUsable(user) {
    // Deny-list, not allow-list. The four states are ACTIVE, ONBOARDING,
    // INACTIVE and TERMINATED, and the model defaults to ONBOARDING — an
    // employee being set up has to be able to sign in, which is the whole
    // point of that state. Only the two that mean "this person no longer works
    // here" are refused.
    const DENIED = [EmployeeStatus.INACTIVE, EmployeeStatus.TERMINATED];
    if (!user || DENIED.includes(user.status)) {
      throw new UnauthorizedError('Invalid credentials');
    }
  }

  async login(email, password) {
    const user = await User.scope('withPassword').findOne({ where: { email } });
    if (!user) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    AuthService.assertUsable(user);

    const accessToken = await this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user.id);

    const userJson = user.toJSON();
    delete userJson.passwordHash;
    userJson.permissions = await this.getPermissionsForUser(user.id, user.role);

    return {
      accessToken,
      refreshToken,
      user: userJson,
    };
  }

  async refresh(refreshToken) {
    if (!refreshToken) {
      throw new UnauthorizedError('No refresh token provided');
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    const user = await User.findByPk(decoded.userId);
    if (!user) {
      throw new UnauthorizedError('User not found');
    }
    // Re-checked on every refresh, which is the only point at which a
    // still-valid session can be cut short: the access token itself is
    // stateless and lives for 15 minutes.
    AuthService.assertUsable(user);

    const accessToken = await this.generateAccessToken(user);
    return { accessToken };
  }

  async getMe(userId) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }
    const userJson = user.toJSON();
    userJson.permissions = await this.getPermissionsForUser(user.id, user.role);

    // The tenant's sidebar customisation rides along with the session.
    //
    // It cannot come from GET /settings/navigation, because that route is gated
    // on SETTINGS_READ and almost nobody holds it — the storekeeper would then
    // see the default menu while the administrator saw the customised one,
    // which is the opposite of what customising a menu is for. It is a display
    // preference, not a secret, so every authenticated user gets it here.
    try {
      const { TenantSettings } = require('../settings/settings.model');
      const row = await TenantSettings.findOne({ where: { key: 'navigation' } });
      userJson.navigationPreferences = row ? row.value : null;
    } catch {
      // A missing or unreadable preference must never block sign-in — the UI
      // falls back to the built-in menu.
      userJson.navigationPreferences = null;
    }

    return userJson;
  }

  async forgotPassword(email) {
    const user = await User.findOne({ where: { email } });
    if (!user) {
      return { message: 'If an account exists with that email, a password reset link has been sent.' };
    }

    // Security Rule: Protect Platform Owner / System Admins / Tenant Owners from public forgot password reset!
    if (user.isSystem || user.role === SystemRoles.PLATFORM_ADMIN || user.role === SystemRoles.TENANT_OWNER) {
      throw new BadRequestError('Password reset via public link is disabled for Platform Owner / System Administrator accounts. Please contact system support.');
    }

    const resetToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(resetToken).digest('hex');
    const resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000);

    user.resetPasswordToken = hashedToken;
    user.resetPasswordExpires = resetPasswordExpires;
    await user.save();

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

    const emailResult = await emailService.sendPasswordResetEmail({
      email: user.email,
      name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'User',
      resetUrl,
    });

    return {
      message: 'Password reset link has been sent to your email.',
      ...emailResult,
    };
  }

  async resetPassword(token, newPassword) {
    if (!token || !newPassword) {
      throw new BadRequestError('Token and new password are required.');
    }

    const hashedToken = crypto.createHash('sha256').update(token).digest('hex');

    const user = await User.scope('withPassword').findOne({
      where: {
        resetPasswordToken: hashedToken,
        resetPasswordExpires: { [Op.gt]: new Date() },
      },
    });

    if (!user) {
      throw new BadRequestError('Password reset token is invalid or has expired.');
    }

    // Security Rule: Protect Platform Owner / System Admins / Tenant Owners
    if (user.isSystem || user.role === SystemRoles.PLATFORM_ADMIN || user.role === SystemRoles.TENANT_OWNER) {
      throw new BadRequestError('Password reset via public link is disabled for Platform Owner / System Administrator accounts.');
    }

    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();

    return { message: 'Password has been reset successfully. You can now log in.' };
  }
}

module.exports = { authService: new AuthService() };
