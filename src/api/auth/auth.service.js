const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { User } = require('../users/user.model');
const { AdGroup } = require('../roles/role.model');
const { AdGroupMember } = require('../roles/adGroupMember.model');
const { env } = require('../../config/env');
const { UnauthorizedError, NotFoundError } = require('../../core/AppError');

class AuthService {
  /**
   * Aggregates the permissions granted to a user through all active AdGroups
   * (roles) they're a member of. This is what the `authorize()` middleware checks
   * against — previously this was hardcoded to `[]`, so every permission check
   * failed for every role except the bypass roles (PLATFORM_ADMIN/TENANT_OWNER).
   */
  async getPermissionsForUser(userId) {
    const memberships = await AdGroupMember.findAll({
      where: { employeeId: userId },
      include: [{ model: AdGroup, attributes: ['permissions', 'status'] }],
    });

    const permissions = new Set();
    for (const membership of memberships) {
      const group = membership.AdGroup;
      if (group && group.status === 'active' && Array.isArray(group.permissions)) {
        group.permissions.forEach((permission) => permissions.add(permission));
      }
    }
    return Array.from(permissions);
  }

  async generateAccessToken(user) {
    const permissions = await this.getPermissionsForUser(user.id);
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

  async login(email, password) {
    const user = await User.scope('withPassword').findOne({ where: { email } });
    if (!user) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const isValid = await bcrypt.compare(password, user.passwordHash);
    if (!isValid) {
      throw new UnauthorizedError('Invalid credentials');
    }

    const accessToken = await this.generateAccessToken(user);
    const refreshToken = this.generateRefreshToken(user.id);

    const userJson = user.toJSON();
    delete userJson.passwordHash;

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

    const accessToken = await this.generateAccessToken(user);
    return { accessToken };
  }

  async getMe(userId) {
    const user = await User.findByPk(userId);
    if (!user) {
      throw new NotFoundError('User not found');
    }
    return user;
  }
}

module.exports = { authService: new AuthService() };
