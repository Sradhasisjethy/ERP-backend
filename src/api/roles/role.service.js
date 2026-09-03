const { Op } = require('sequelize');
const { AdGroup } = require('./role.model');
const { AdGroupMember } = require('./adGroupMember.model');
const { User } = require('../users/user.model');
const { NotFoundError, ForbiddenError } = require('../../core/AppError');
const { SystemRoles } = require('../../utils/constants');
const {
  ALL_PERMISSIONS,
  WILDCARD,
  expandPermissions,
  normalizePermissions,
} = require('../../utils/permissionCatalog');

const BYPASS_ROLES = [SystemRoles.PLATFORM_ADMIN, SystemRoles.TENANT_OWNER];

class RoleService {
  /** A bypass system role, or a role carrying the `*` wildcard. */
  static hasFullAccess(actor) {
    return BYPASS_ROLES.includes(actor?.role) || (actor?.permissions || []).includes(WILDCARD);
  }

  /**
   * You cannot grant what you do not hold.
   *
   * Without this, ROLE_CREATE is effectively root: anyone who can author a role
   * could mint one carrying VIEW_RATES or PURCHASE_APPROVE and assign it to
   * themselves. Compared on *expanded* sets, so holding `PRODUCT_CREATE` alone
   * doesn't let you hand out the legacy `PRODUCT_WRITE`.
   *
   * Only what's being *added* is checked. The editor always submits the full
   * permission list, so checking the whole set would 403 a limited role-admin for
   * renaming a role that happens to out-rank them. Removing a permission you
   * can't grant is fine — it can only reduce access.
   */
  static assertGrantable(actor, permissions, existing = []) {
    if (!Array.isArray(permissions)) return;
    if (this.hasFullAccess(actor)) return;

    const held = new Set(expandPermissions(actor?.permissions || []));
    const alreadyGranted = new Set(expandPermissions(existing));
    const escalating = expandPermissions(permissions).filter(
      (code) => !held.has(code) && !alreadyGranted.has(code)
    );

    if (escalating.length) {
      throw new ForbiddenError(
        `You cannot grant permissions you do not hold: ${escalating.sort().join(', ')}`
      );
    }
  }

  /** The codes `actor` is allowed to put on a role — the read side of assertGrantable. */
  static grantableFor(actor) {
    if (this.hasFullAccess(actor)) return ALL_PERMISSIONS;
    const known = new Set(ALL_PERMISSIONS);
    return expandPermissions(actor?.permissions || []).filter((code) => known.has(code));
  }

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

  static async createRole(data, actor) {
    this.assertGrantable(actor, data.permissions);
    return AdGroup.create({ ...data, permissions: normalizePermissions(data.permissions) });
  }

  static async updateRole(id, data, actor) {
    const role = await this.getRole(id);

    // A partial update that doesn't mention permissions must leave them alone —
    // normalising `undefined` would blank them out.
    if (data.permissions === undefined) return role.update(data);

    this.assertGrantable(actor, data.permissions, role.permissions || []);
    return role.update({ ...data, permissions: normalizePermissions(data.permissions) });
  }

  static async deleteRole(id) {
    const role = await this.getRole(id);
    await role.destroy();
    return true;
  }

  static async getMembers(adGroupId) {
    const role = await this.getRole(adGroupId);
    return AdGroupMember.findAll({
      where: { adGroupId: role.id },
      include: [{ model: User, attributes: ['id', 'firstName', 'lastName', 'email', 'avatar', 'role'] }],
    });
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
