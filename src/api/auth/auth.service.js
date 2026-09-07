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
const { RefreshToken } = require('./refreshToken.model');

/**
 * Seven days, in one place. The cookie's lifetime is derived from these rather
 * than written out again — the two used to disagree, so the browser threw away
 * an access token that was still valid for another forty-five minutes.
 */
const REFRESH_TTL_DAYS = 7;
const REFRESH_TTL_MS = REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000;

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
      permissions.add(WebPermissions.PARTY_READ);
      permissions.add(WebPermissions.PRODUCT_READ);
      permissions.add(WebPermissions.INVENTORY_READ);
      permissions.add(WebPermissions.SALES_READ);
      permissions.add(WebPermissions.PURCHASE_READ);
      permissions.add(WebPermissions.PRODUCTION_READ);
      permissions.add(WebPermissions.QUALITY_READ);
      permissions.add(WebPermissions.TRANSFER_READ);
      permissions.add(WebPermissions.DISPATCH_READ);
      permissions.add(WebPermissions.INVOICE_READ);
    }
    // EMPLOYEE deliberately grants nothing on its own.
    //
    // It used to hand every employee blanket read access across sales,
    // purchase, production, inventory, quality, dispatch and invoicing before
    // any AdGroup was consulted. That made the seven plant roles in
    // constants/defaultRoles.js decorative for reads — a Sales Executive could
    // read the casting sheet, an accountant could read production, and a user
    // in no group at all could list every employee. It also sat awkwardly with
    // BR-07, which exists to keep commercial figures away from the shop floor.
    //
    // An employee now gets exactly what their groups give them.

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
      { expiresIn: env.JWT_ACCESS_EXPIRATION || '1h', algorithm: 'HS256' }
    );
  }

  /**
   * Issues a refresh token and records it as live.
   *
   * The token carries a `jti` and this is the only thing that makes it
   * revocable: a bare signed JWT is valid until it expires no matter what
   * happens to the account, so logout could not end a session and a copied
   * token outlived the one that created it.
   */
  async issueRefreshToken(user, { context = {}, replaces = null } = {}) {
    const jti = crypto.randomUUID();
    const expiresAt = new Date(Date.now() + REFRESH_TTL_MS);

    await RefreshToken.create({
      tenantId: user.tenantId,
      userId: user.id,
      jti,
      expiresAt,
      userAgent: (context.userAgent || '').slice(0, 300) || null,
      ipAddress: context.ipAddress || null,
    });

    if (replaces) {
      await RefreshToken.update(
        { replacedBy: jti },
        { where: { jti: replaces } }
      );
    }

    return jwt.sign({ userId: user.id, jti }, env.JWT_REFRESH_SECRET, {
      expiresIn: `${REFRESH_TTL_DAYS}d`,
      algorithm: 'HS256',
    });
  }

  /** Ends sessions. `jti` for one device, or every token the user holds. */
  static async revokeRefreshTokens({ jti, userId, reason }) {
    const where = jti ? { jti } : { userId };
    await RefreshToken.update(
      { revokedAt: new Date(), revokedReason: reason || 'REVOKED' },
      { where: { ...where, revokedAt: null } }
    );
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

  async login(email, password, context = {}) {
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
    const refreshToken = await this.issueRefreshToken(user, { context });

    const userJson = user.toJSON();
    delete userJson.passwordHash;
    userJson.permissions = await this.getPermissionsForUser(user.id, user.role);

    return {
      accessToken,
      refreshToken,
      user: userJson,
    };
  }

  async refresh(refreshToken, context = {}) {
    if (!refreshToken) {
      throw new UnauthorizedError('No refresh token provided');
    }

    let decoded;
    try {
      decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
    } catch (err) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    const user = await User.unscoped().findByPk(decoded.userId);
    if (!user) {
      throw new UnauthorizedError('User not found');
    }
    // Re-checked on every refresh, which is the only point at which a
    // still-valid session can be cut short: the access token itself is
    // stateless and lives for 15 minutes.
    AuthService.assertUsable(user);

    // The signature only proves the token was issued by us; this proves it has
    // not since been ended. Without it, logout, a password reset and disabling
    // an account were all advisory for up to seven days.
    const stored = decoded.jti
      ? await RefreshToken.unscoped().findOne({ where: { jti: decoded.jti } })
      : null;

    if (!stored) {
      // Either a token issued before this table existed, or one that was never
      // ours. Both are refused: accepting unknown tokens would leave exactly
      // the hole this closes.
      throw new UnauthorizedError('Invalid refresh token');
    }

    if (stored.revokedAt) {
      // Only a token spent by ROTATION is evidence of a copy: the legitimate
      // holder moved on to its replacement, so whoever still has this one
      // should not. Every session for the user ends.
      //
      // A token revoked any other way — logout, a password reset — is just
      // stale. Refuse it and stop there. Treating those as theft would mean a
      // single stray retry from a browser that had signed out took down the
      // user's other devices, which is its own kind of outage.
      if (stored.revokedReason === 'ROTATED') {
        await AuthService.revokeRefreshTokens({ userId: stored.userId, reason: 'REUSE_DETECTED' });
      }
      throw new UnauthorizedError('Invalid refresh token');
    }

    if (stored.expiresAt <= new Date()) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    // Rotate: the presented token is spent, and a fresh one takes its place.
    await AuthService.revokeRefreshTokens({ jti: decoded.jti, reason: 'ROTATED' });
    const accessToken = await this.generateAccessToken(user);
    const newRefreshToken = await this.issueRefreshToken(user, { context, replaces: decoded.jti });

    return { accessToken, refreshToken: newRefreshToken };
  }

  /** Ends one session — the device that presented this token, and no other. */
  async logout(refreshToken) {
    if (!refreshToken) return;
    try {
      const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
      if (decoded.jti) await AuthService.revokeRefreshTokens({ jti: decoded.jti, reason: 'LOGOUT' });
    } catch {
      // An expired or malformed token needs no revoking, and logout must
      // succeed regardless — a user signing out should never see an error.
    }
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

    // Everything the old password could reach is now closed. Someone resetting
    // a password has usually lost control of the account, and leaving working
    // refresh tokens behind would hand the intruder another seven days.
    await AuthService.revokeRefreshTokens({ userId: user.id, reason: 'PASSWORD_RESET' });

    return { message: 'Password has been reset successfully. You can now log in.' };
  }
}

module.exports = { authService: new AuthService() };
