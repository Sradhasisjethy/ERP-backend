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
const { bumpUser, bumpRoleMembers } = require('../../utils/permissionVersion');

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
    const updated = await role.update({ ...data, permissions: normalizePermissions(data.permissions) });
    // Everyone holding this role is now carrying a token that describes the old
    // grant, so retire those tokens rather than wait out the hour.
    await bumpRoleMembers(role.id);
    return updated;
  }

  /**
   * Deleting a role is not the mirror of editing one.
   *
   * `assertGrantable` deliberately lets a limited author *remove* a permission
   * they could not grant, because that only reduces access. Deleting the whole
   * role does not reduce the actor's access — it strips it from everyone else
   * who held it, silently and with no way back. Two rules follow:
   *
   *  1. You may not delete a role that out-ranks you. Otherwise ROLE_DELETE is
   *     a way to disable administrators more powerful than yourself, which is
   *     the same threat assertGrantable exists to stop, pointed the other way.
   *  2. The last role carrying the wildcard cannot go. A tenant ships with a
   *     seeded "Platform Admin" role holding `*`, nothing marked it as special,
   *     and deleting it locked the tenant out of its own administration with a
   *     single request — recoverable only by direct database access.
   */
  static async deleteRole(id, actor) {
    const role = await this.getRole(id);

    this.assertGrantable(actor, role.permissions || []);

    if ((role.permissions || []).includes(WILDCARD)) {
      const remaining = await AdGroup.count({
        where: { id: { [Op.ne]: role.id }, status: 'active', permissions: { [Op.contains]: [WILDCARD] } },
      });
      if (remaining === 0) {
        throw new ForbiddenError(
          'This is the last role with full access. Deleting it would leave the tenant with no administrator — create another first.'
        );
      }
    }

    // Read the membership before the rows go, then retire their tokens.
    await bumpRoleMembers(role.id);
    await role.destroy();
    return true;
  }

  /**
   * Where a user's access actually comes from.
   *
   * Administration > Roles shows role rows, which is only part of the picture:
   * the `users.role` column grants permissions of its own through
   * permissionsForSystemRole, from code rather than from a row. That is how
   * ORG_ADMIN came to hold the entire catalog with nothing in the UI to show
   * it and no way to take it back. Splitting the answer by source means an
   * administrator can see *why* someone can do something, not just that they
   * can — and the brief's "effective permissions" view has something to render.
   */
  static async effectivePermissionsFor(userId) {
    const { permissionsForSystemRole } = require('../../utils/systemRolePermissions');

    const user = await User.findByPk(userId, { attributes: ['id', 'firstName', 'lastName', 'email', 'role'] });
    if (!user) throw new NotFoundError('User not found');

    const memberships = await AdGroupMember.findAll({
      where: { employeeId: userId },
      include: [{ model: AdGroup, attributes: ['id', 'name', 'status', 'permissions'] }],
    });

    const fromSystemRole = expandPermissions(permissionsForSystemRole(user.role));
    const roles = memberships
      .filter((m) => m.AdGroup)
      .map((m) => ({
        id: m.AdGroup.id,
        name: m.AdGroup.name,
        status: m.AdGroup.status,
        // An inactive role contributes nothing, and saying so is more useful
        // than quietly omitting it.
        applied: m.AdGroup.status === 'active',
        permissions: expandPermissions(m.AdGroup.permissions || []),
      }));

    const effective = expandPermissions([
      ...permissionsForSystemRole(user.role),
      ...roles.filter((r) => r.applied).flatMap((r) => r.permissions),
    ]);

    return {
      user: { id: user.id, name: `${user.firstName || ''} ${user.lastName || ''}`.trim(), email: user.email },
      systemRole: user.role,
      fromSystemRole,
      roles,
      effective: effective.sort(),
    };
  }

  static async getMembers(adGroupId) {
    const role = await this.getRole(adGroupId);
    return AdGroupMember.findAll({
      where: { adGroupId: role.id },
      include: [{ model: User, attributes: ['id', 'firstName', 'lastName', 'email', 'avatar', 'role'] }],
    });
  }

  /**
   * Putting someone into a role hands them that role's permissions, so it is a
   * grant and has to clear the same bar as authoring one.
   *
   * assertGrantable used to protect only the authoring routes, which left the
   * shorter road open: a tenant ships a seeded "Platform Admin" role carrying
   * `*`, GET /roles hands its id to any ROLE_READ holder, and ROLE_CREATE was
   * enough to POST yourself into it. One request, re-login, superuser — without
   * ever minting a role assertGrantable would have refused.
   *
   * `existing` is deliberately not passed: the member holds none of this role's
   * permissions yet, so every one of them is being added.
   */
  static async assignMember(adGroupId, employeeId, actor) {
    const role = await this.getRole(adGroupId);
    this.assertGrantable(actor, role.permissions || []);
    const [member] = await AdGroupMember.findOrCreate({
      where: { adGroupId: role.id, employeeId },
      defaults: { adGroupId: role.id, employeeId },
    });
    await bumpUser(employeeId);
    return member;
  }

  static async removeMember(adGroupId, employeeId) {
    const member = await AdGroupMember.findOne({ where: { adGroupId, employeeId } });
    if (!member) throw new NotFoundError('Member not found in role');
    await member.destroy();
    // The point of removing someone is that they lose the access now.
    await bumpUser(employeeId);
    return true;
  }
}

module.exports = { RoleService };
