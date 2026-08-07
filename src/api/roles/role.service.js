const { Op } = require('sequelize');
const { AdGroup } = require('./role.model');
const { AdGroupMember } = require('./adGroupMember.model');
const { NotFoundError } = require('../../core/AppError');

class RoleService {
  static async listRoles(page, limit, search, status) {
    const offset = (page - 1) * limit;
    const where = {};
    if (search) where.name = { [Op.iLike]: `%${search}%` };
    if (status) where.status = status;

    return AdGroup.findAndCountAll({ where, limit, offset });
  }

  static async getRole(id) {
    const role = await AdGroup.findByPk(id, {
      include: [
        {
          model: AdGroupMember,
          attributes: ['id', 'employeeId'],
        },
      ],
    });
    if (!role) throw new NotFoundError('Role not found');
    return role;
  }

  static async createRole(data) {
    return AdGroup.create(data);
  }

  static async updateRole(id, data) {
    const role = await this.getRole(id);
    return role.update(data);
  }

  static async deleteRole(id) {
    const role = await this.getRole(id);
    await role.destroy();
    return true;
  }

  static async getMembers(adGroupId) {
    const role = await this.getRole(adGroupId);
    return AdGroupMember.findAll({ where: { adGroupId: role.id } });
  }

  static async assignMember(adGroupId, employeeId) {
    const role = await this.getRole(adGroupId);
    const [member] = await AdGroupMember.findOrCreate({
      where: { adGroupId: role.id, employeeId },
      defaults: { adGroupId: role.id, employeeId },
    });
    return member;
  }

  static async removeMember(adGroupId, employeeId) {
    const member = await AdGroupMember.findOne({ where: { adGroupId, employeeId } });
    if (!member) throw new NotFoundError('Member not found in role');
    await member.destroy();
    return true;
  }
}

module.exports = { RoleService };
