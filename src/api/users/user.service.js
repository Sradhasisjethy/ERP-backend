const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { Op } = require('sequelize');
const { User, Department, Office, Organization, AdGroupMember, AdGroup, Tenant } = require('../../models');
const { getTenantId } = require('../../core/tenantContext');
const { NotFoundError } = require('../../core/AppError');
const emailService = require('../../services/email.service');

class UserService {
  async list(query) {
    const { page = 1, limit = 20, search, status, employeeType, departmentId, organizationId } = query;
    const offset = (page - 1) * limit;

    const where = {};
    if (status) where.status = status;
    if (employeeType) where.employeeType = employeeType;
    if (departmentId) where.departmentId = departmentId;
    if (organizationId) where.organizationId = organizationId;

    if (search) {
      where[Op.or] = [
        { firstName: { [Op.iLike]: `%${search}%` } },
        { lastName: { [Op.iLike]: `%${search}%` } },
        { email: { [Op.iLike]: `%${search}%` } },
      ];
    }

    const { rows, count } = await User.findAndCountAll({
      where,
      limit,
      offset,
      include: [
        { model: User, as: 'manager', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: User, as: 'hr', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: Department, attributes: ['id', 'name', 'code'] },
        { model: Office, attributes: ['id', 'name', 'city', 'country'] },
        { model: Organization, attributes: ['id', 'name', 'code'] },
        {
          model: AdGroupMember,
          attributes: ['id', 'adGroupId'],
          include: [{ model: AdGroup, attributes: ['id', 'name', 'code'] }],
        },
      ],
      order: [['createdAt', 'DESC']],
    });

    return {
      rows,
      count,
      page,
      limit,
      totalPages: Math.ceil(count / limit),
    };
  }

  async getById(id) {
    const user = await User.findByPk(id, {
      include: [
        { model: User, as: 'manager', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: User, as: 'hr', attributes: ['id', 'firstName', 'lastName', 'email'] },
        { model: Department, attributes: ['id', 'name', 'code'] },
        { model: Office, attributes: ['id', 'name', 'city', 'country'] },
        { model: Organization, attributes: ['id', 'name', 'code'] },
        {
          model: AdGroupMember,
          attributes: ['id', 'adGroupId'],
          include: [{ model: AdGroup, attributes: ['id', 'name', 'code'] }],
        },
      ],
    });

    if (!user) {
      throw new NotFoundError('User not found');
    }

    return user;
  }

  async create(data) {
    const { password, sendInvite = true, roleId, ...rest } = data;
    
    // If password provided, hash it; otherwise generate random secure initial hash
    const rawPassword = password || crypto.randomBytes(32).toString('hex');
    const passwordHash = await bcrypt.hash(rawPassword, 10);

    // Generate onboarding setup token (valid for 48 hours)
    const setupToken = crypto.randomBytes(32).toString('hex');
    const hashedToken = crypto.createHash('sha256').update(setupToken).digest('hex');
    const resetPasswordExpires = new Date(Date.now() + 48 * 60 * 60 * 1000);

    const user = await User.create({
      ...rest,
      passwordHash,
      resetPasswordToken: hashedToken,
      resetPasswordExpires,
    });

    if (roleId) {
      const activeTenantId = getTenantId() || user.tenantId || (await Tenant.findOne())?.id;
      await AdGroupMember.create({
        adGroupId: roleId,
        employeeId: user.id,
        tenantId: activeTenantId,
      });
    }

    // Send Welcome / Set Password Invitation Email
    if (sendInvite || !password) {
      const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
      const setupUrl = `${frontendUrl}/reset-password?token=${setupToken}`;

      emailService.sendWelcomeInviteEmail({
        email: user.email,
        name: `${user.firstName || ''} ${user.lastName || ''}`.trim() || 'Team Member',
        setupUrl,
      }).catch((err) => {
        console.error('[UserService] Failed to send welcome invitation email:', err.message);
      });
    }

    const userJson = user.toJSON();
    delete userJson.passwordHash;
    delete userJson.resetPasswordToken;
    delete userJson.resetPasswordExpires;
    return userJson;
  }

  async update(id, data) {
    const user = await User.findByPk(id);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    const { roleId, ...rest } = data;
    await user.update(rest);

    if (roleId !== undefined) {
      await AdGroupMember.destroy({ where: { employeeId: user.id } });
      if (roleId) {
        const activeTenantId = getTenantId() || user.tenantId || (await Tenant.findOne())?.id;
        await AdGroupMember.create({
          adGroupId: roleId,
          employeeId: user.id,
          tenantId: activeTenantId,
        });
      }
    }

    return user;
  }

  async delete(id) {
    const user = await User.findByPk(id);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    await user.destroy();
    return true;
  }
}

module.exports = { userService: new UserService() };
