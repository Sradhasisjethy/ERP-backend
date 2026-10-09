// Native bcrypt, not bcryptjs. Same algorithm, same hashes either way round —
// but bcryptjs runs its ~100 ms of key stretching on the one Node thread,
// where ten logins a second is a saturated core and a Monday-morning login
// wave stalls every other request. The native build does the same work in
// libuv's thread pool and hands the main thread back in under a millisecond.
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { User } = require('../users/user.model');
const { Tenant } = require('../organization/tenant.model');
const { AdGroup } = require('../roles/role.model');
const { AdGroupMember } = require('../roles/adGroupMember.model');
const { env } = require('../../config/env');
const { UnauthorizedError, NotFoundError, BadRequestError } = require('../../core/AppError');
const { expandPermissions } = require('../../utils/permissionCatalog');
const emailService = require('../../services/email.service');
const { SystemRoles, EmployeeStatus } = require('../../utils/constants');
const { permissionsForSystemRole } = require('../../utils/systemRolePermissions');
const { RefreshToken } = require('./refreshToken.model');
const { bumpUser } = require('../../utils/permissionVersion');
const { getTenantId } = require('../../core/tenantContext');
const { logger } = require('../../utils/logger');

const FORGOT_PASSWORD_MESSAGE = 'If an account exists with that email, a password reset link has been sent.';

// A valid bcrypt hash of a random string, compared against when no account
// matches so that a miss costs the same time as a wrong password.
const TIMING_DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);

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

    // Default role-based permissions. The mapping lives in
    // utils/systemRolePermissions.js because assigning the role column is also a
    // grant, and the user-administration guard has to read the same table.
    permissionsForSystemRole(role).forEach((p) => permissions.add(p));
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
      // Login and refresh run outside a request's tenant context, where the
      // model hooks filter nothing — so memberships were read from every
      // tenant. A role in tenant B naming a tenant-A user's id then granted
      // that user its permissions inside tenant A. Memberships and the roles
      // they point at must both belong to the user's own tenant.
      const tenantId =
        getTenantId() || (await User.unscoped().findByPk(userId, { attributes: ['tenantId'] }))?.tenantId;
      if (!tenantId) return expandPermissions(Array.from(permissions));

      const memberships = await AdGroupMember.findAll({
        where: { employeeId: userId, tenantId },
        include: [{ model: AdGroup, attributes: ['permissions', 'status'], where: { tenantId }, required: true }],
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
        // What makes the token revocable: `authenticate` refuses it once the
        // user's stored counter moves past this. See utils/permissionVersion.js.
        permissionsVersion: user.permissionsVersion ?? 1,
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
    const [count] = await RefreshToken.update(
      { revokedAt: new Date(), revokedReason: reason || 'REVOKED' },
      { where: { ...where, revokedAt: null } }
    );
    // How many were still live — rotation relies on this to win a race.
    return count;
  }

  /**
   * A company that has been suspended or switched off signs nobody in.
   *
   * The tenant's status column existed but nothing read it, so suspending a
   * customer changed nothing for its users. Only the two explicit "off" states
   * are refused: a row with any other value keeps working, so this can never
   * lock out a live company over a status nobody set.
   */
  static async assertTenantUsable(tenantId) {
    const tenant = await Tenant.findByPk(tenantId, { attributes: ['id', 'status'] });
    if (!tenant || ['inactive', 'suspended'].includes(tenant.status)) {
      throw new UnauthorizedError('Invalid credentials');
    }
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
      // Spend the same bcrypt time an existing account would, so the response
      // time does not say which emails are registered.
      await bcrypt.compare(password, TIMING_DUMMY_HASH);
      throw new UnauthorizedError('Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    AuthService.assertUsable(user);
    await AuthService.assertTenantUsable(user.tenantId);

    const accessToken = await this.generateAccessToken(user);
    const refreshToken = await this.issueRefreshToken(user, { context });

    const userJson = user.toJSON();
    // Loaded through `withPassword`, so every credential column is present.
    delete userJson.passwordHash;
    delete userJson.resetPasswordToken;
    delete userJson.resetPasswordExpires;
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
    // Re-checked on every refresh. This used to be the *only* point at which a
    // still-valid session could be cut short, because the access token was
    // verified by signature alone and lives for JWT_ACCESS_EXPIRATION — an hour
    // by default, not the fifteen minutes this comment used to claim.
    // `authenticate` now also checks the account's status and permissions
    // version on each request, so a disabled or demoted user is stopped there;
    // this remains the point at which a *new* token picks up the change.
    AuthService.assertUsable(user);
    await AuthService.assertTenantUsable(user.tenantId);

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
        // A copy is loose, so its access tokens die too — not in an hour.
        await bumpUser(stored.userId);
      }
      throw new UnauthorizedError('Invalid refresh token');
    }

    if (stored.expiresAt <= new Date()) {
      throw new UnauthorizedError('Invalid refresh token');
    }

    // Rotate: the presented token is spent, and a fresh one takes its place.
    //
    // The revoke is the claim. Two requests presenting the same token used to
    // both pass the check above and both mint new sessions — a stolen token
    // racing the real one got a parallel session and reuse detection never
    // fired. Only one UPDATE can flip revokedAt from null; the loser is reuse.
    const claimed = await AuthService.revokeRefreshTokens({ jti: decoded.jti, reason: 'ROTATED' });
    if (claimed === 0) {
      await AuthService.revokeRefreshTokens({ userId: stored.userId, reason: 'REUSE_DETECTED' });
      await bumpUser(stored.userId);
      throw new UnauthorizedError('Invalid refresh token');
    }
    const accessToken = await this.generateAccessToken(user);
    const newRefreshToken = await this.issueRefreshToken(user, { context, replaces: decoded.jti });

    return { accessToken, refreshToken: newRefreshToken };
  }

  /**
   * Ends this device's session. Its refresh token is revoked, and the user's
   * access tokens are retired so the one this device held stops working now
   * rather than in up to an hour; other devices refresh transparently.
   */
  async logout(refreshToken) {
    if (!refreshToken) return;
    try {
      const decoded = jwt.verify(refreshToken, env.JWT_REFRESH_SECRET, { algorithms: ['HS256'] });
      if (decoded.jti) {
        const revoked = await AuthService.revokeRefreshTokens({ jti: decoded.jti, reason: 'LOGOUT' });
        if (revoked) await bumpUser(decoded.userId);
      }
    } catch {
      // An expired or malformed token needs no revoking, and logout must
      // succeed regardless — a user signing out should never see an error.
    }
  }

  /** Ends every session the user has, on every device. */
  async logoutAll(userId) {
    await AuthService.revokeRefreshTokens({ userId, reason: 'LOGOUT_ALL' });
    await bumpUser(userId);
  }

  /**
   * Changes a signed-in user's password. The current password is required —
   * a session left open on a shared machine must not be enough to take the
   * account — and every session ends afterwards, this one included.
   */
  async changePassword(userId, currentPassword, newPassword) {
    const user = await User.scope('withPassword').findByPk(userId);
    // 400, not 401: the session is fine, the form input is wrong — a 401 makes
    // the client try to refresh the session and retry.
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) {
      throw new BadRequestError('Current password is incorrect');
    }
    user.passwordHash = await bcrypt.hash(newPassword, 10);
    user.resetPasswordToken = null;
    user.resetPasswordExpires = null;
    await user.save();
    await this.logoutAll(user.id);
    return { message: 'Password changed. Please sign in again.' };
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

  /**
   * Always answers with the same message, whatever happened.
   *
   * This used to return the email service's result to the caller, and that
   * result carries the reset link itself whenever SMTP is unconfigured or the
   * send fails — an anonymous POST with someone's email got back a working link
   * to their account. It also answered differently for unknown emails, known
   * ones, and owner/admin accounts (a 400 naming the role), which told a
   * stranger who works here and who holds the keys. The link now goes only to
   * the mailbox; failures are logged against the user id, never the token.
   */
  async forgotPassword(email) {
    const user = await User.findOne({ where: { email } });

    // Owner, platform and system accounts are not reset through a public link —
    // but saying so would confirm the account and its rank, so they get the
    // same answer as everyone else.
    const resettable =
      user && !(user.isSystem || user.role === SystemRoles.PLATFORM_ADMIN || user.role === SystemRoles.TENANT_OWNER);

    if (resettable) {
      const resetToken = crypto.randomBytes(32).toString('hex');
      user.resetPasswordToken = crypto.createHash('sha256').update(resetToken).digest('hex');
      user.resetPasswordExpires = new Date(Date.now() + 15 * 60 * 1000);
      await user.save();

      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}`;

      // Not awaited: waiting on SMTP only for real accounts made the response
      // time say which emails are registered.
      Promise.resolve()
        .then(() =>
          emailService.sendPasswordResetEmail({
            email: user.email,
            name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'User',
            resetUrl,
          })
        )
        .catch((error) => {
          logger.error({ message: 'Password reset email failed', userId: user.id, error: error.message });
        });
    }

    return { message: FORGOT_PASSWORD_MESSAGE };
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

    // Refresh tokens are revoked below, but an access token already issued
    // would otherwise keep working until it expired (up to an hour). Bumping
    // the version makes `authenticate` refuse it on the next request.
    await bumpUser(user.id);

    // Everything the old password could reach is now closed. Someone resetting
    // a password has usually lost control of the account, and leaving working
    // refresh tokens behind would hand the intruder another seven days.
    await AuthService.revokeRefreshTokens({ userId: user.id, reason: 'PASSWORD_RESET' });

    return { message: 'Password has been reset successfully. You can now log in.' };
  }
}

module.exports = { authService: new AuthService() };
