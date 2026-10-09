const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Op, QueryTypes } = require('sequelize');
const { User, Department, Office, Organization, AdGroupMember, AdGroup } = require('../../models');
const { getTenantId } = require('../../core/tenantContext');
const { containsPattern } = require('../../utils/pagination');
const { NotFoundError, ForbiddenError, ValidationError } = require('../../core/AppError');
const { SystemRoles } = require('../../utils/constants');
const emailService = require('../../services/email.service');
const { RoleService } = require('../roles/role.service');
const { permissionsForSystemRole } = require('../../utils/systemRolePermissions');
const { bumpUser } = require('../../utils/permissionVersion');

/**
 * Refuses a user write that would hand out access the author does not have.
 *
 * The user editor is a second door onto the permission system, and it was
 * standing open. Two fields do it:
 *
 *   `role`   — the system-role column. SystemRoles includes PLATFORM_ADMIN and
 *              TENANT_OWNER, the two roles authorize.js lets past every check,
 *              so `PUT /users/<self> {"role":"PLATFORM_ADMIN"}` was a one-request
 *              path from an ordinary HR grant to superuser on next login.
 *   `roleId` — AdGroup membership, i.e. exactly what RoleService.assignMember
 *              guards. Routing it through the user editor skipped that guard.
 *
 * Both are checked against the same `assertGrantable` rule the role editor uses,
 * so there is one definition of "you cannot grant what you do not hold" rather
 * than three. A full-access actor is unaffected.
 */
const assertRoleAssignable = async (actor, { role, roleId }) => {
  if (role === undefined && roleId === undefined) return;
  if (RoleService.hasFullAccess(actor)) return;

  if (role !== undefined) {
    // What the column is worth, compared against what the author holds.
    RoleService.assertGrantable(actor, permissionsForSystemRole(role));
  }

  if (roleId) {
    const group = await AdGroup.findByPk(roleId);
    if (!group) throw new NotFoundError('Role not found');
    RoleService.assertGrantable(actor, group.permissions || []);
  }
};

/**
 * The columns a user write may set, and nothing else.
 *
 * The request body reaches this service with every key the caller sent, so
 * `user.update(body)` used to write whatever it was given: `passwordHash`,
 * `isSystem`, `permissionsVersion`, `resetPasswordToken`. An HR user holding
 * EMPLOYEE_MODIFY could set the owner's password hash to one they generated and
 * sign in as the owner. Credentials and access bookkeeping are changed only by
 * the flows that own them (reset, invite, role assignment), never by the editor.
 */
const WRITABLE_FIELDS = [
  'email', 'firstName', 'lastName', 'organizationId', 'officeId', 'departmentId',
  'employeeType', 'role', 'phone', 'employeeCode', 'dateOfJoining', 'resignationDate',
  'gender', 'assetName', 'assetCode', 'address', 'city', 'state', 'country', 'pincode',
  'avatar', 'status', 'managerId', 'hrId', 'parentId',
];

const pickWritable = (data) =>
  Object.fromEntries(Object.entries(data || {}).filter(([key]) => WRITABLE_FIELDS.includes(key)));

const PROTECTED_ROLES = [SystemRoles.PLATFORM_ADMIN, SystemRoles.TENANT_OWNER];

/**
 * You may not edit or delete a user who out-ranks you.
 *
 * EMPLOYEE_MODIFY could otherwise change a stronger user's email and send their
 * reset link to itself, strip their roles (`roleId: null`), demote them or
 * deactivate them — none of which grants the actor a permission, so the grant
 * check alone never noticed. The first version of this guard protected only
 * the owner and platform-admin system roles, which left every administrator
 * whose power comes from a role group (including the seeded `*` group) open.
 *
 * A target out-ranks the actor when it is an owner, platform admin or system
 * account, holds `*`, or holds an administrative code the actor lacks. Ordinary
 * staff and peers stay manageable: HR does not need sales grants to correct a
 * sales executive's phone number.
 */
const assertMayManage = async (actor, target) => {
  if (RoleService.hasFullAccess(actor)) return;
  const refuse = () => {
    throw new ForbiddenError('You cannot change an account with more administrative access than your own');
  };
  if (target.isSystem || PROTECTED_ROLES.includes(target.role)) refuse();

  const { authService } = require('../auth/auth.service');
  const effective = await authService.getPermissionsForUser(target.id, target.role);
  RoleService.assertNotOutranked(actor, effective, 'You cannot change an account with more administrative access than your own');
};

/**
 * Every id a user write points at must exist in this tenant.
 *
 * Foreign keys are plain database references, so another tenant's department,
 * office or employee id satisfied them; the reads then `include`d that row and
 * showed the other tenant's names and emails. Lookups here are tenant-scoped,
 * so a foreign id is simply not found. The role is checked for every actor —
 * assertRoleAssignable skips its own lookup for full-access actors.
 */
const REFERENCES = [
  ['organizationId', Organization, 'Organization'],
  ['officeId', Office, 'Office'],
  ['departmentId', Department, 'Department'],
  ['managerId', User, 'Manager'],
  ['hrId', User, 'HR contact'],
  ['parentId', User, 'Reporting employee'],
];

const assertReferencesInTenant = async (fields, roleId, transaction) => {
  for (const [key, Model, label] of REFERENCES) {
    if (fields[key] && !(await Model.findByPk(fields[key], { attributes: ['id'], transaction }))) {
      throw new NotFoundError(`${label} not found`);
    }
  }
  if (roleId && !(await AdGroup.findByPk(roleId, { attributes: ['id'], transaction }))) {
    throw new NotFoundError('Role not found');
  }
};

/**
 * What EMPLOYEE_READ alone shows: a staff directory.
 *
 * EMPLOYEE_READ is held by the default "Employee" role, so every member of
 * staff could read every colleague's home address, phone, gender and
 * resignation date. Those stay with HR (EMPLOYEE_MODIFY) and with the person.
 */
const DIRECTORY_ATTRIBUTES = [
  'id', 'firstName', 'lastName', 'email', 'employeeCode', 'employeeType', 'status', 'role', 'avatar',
  'organizationId', 'officeId', 'departmentId', 'managerId', 'hrId', 'parentId', 'createdAt', 'updatedAt',
];

/** Undefined (all default-scope columns) for HR, the person, or an internal caller. */
const attributesFor = (actor, targetId) => {
  if (!actor || RoleService.hasFullAccess(actor)) return undefined;
  if (targetId && actor.userId === targetId) return undefined;
  return (actor.permissions || []).includes('EMPLOYEE_MODIFY') ? undefined : DIRECTORY_ATTRIBUTES;
};

const AVATAR_PATH = /^\/uploads\/avatars\/(avatar-[\w-]+\.(?:png|jpe?g|webp))$/;

/**
 * How many employees, in any tenant, point at this avatar path — optionally
 * not counting one of them.
 *
 * uploads/avatars/ is one folder for the whole platform, and every avatar
 * path is visible in the staff directory, so "is anyone else using this file"
 * has to be asked across tenants. That rules out the model: User.count goes
 * through BaseScopedModel.aggregate and the beforeCount hook, both of which
 * add the caller's tenantId whatever scope or hooks option is passed. Soft or
 * hard deleted makes no difference here — every row in the table counts.
 */
const avatarReferences = async (avatar, exceptId) => {
  const [row] = await User.sequelize.query(
    `SELECT COUNT(*)::int AS "count" FROM employees WHERE avatar = :avatar${exceptId ? ' AND id <> :exceptId' : ''}`,
    { replacements: { avatar, exceptId: exceptId || null }, type: QueryTypes.SELECT }
  );
  return row ? row.count : 0;
};

/**
 * Refuses an avatar path that another account already uses.
 *
 * The schema proves the path is one the avatar upload issues, not that this
 * caller was the one it was issued to. Pointing your own picture at a
 * colleague's file was harmless until the file is replaced — then the old one
 * is deleted (removeAvatarFile), and with it the colleague's picture.
 */
const assertAvatarAvailable = async (avatar, targetId) => {
  if (!avatar) return;
  if ((await avatarReferences(avatar, targetId)) > 0) {
    throw new ValidationError('That picture belongs to another account');
  }
};

/**
 * Best-effort removal of a replaced avatar file; never fails the request.
 * Only once nobody — in any tenant — still points at it: rows saved before
 * assertAvatarAvailable existed may share a file, and deleting it then would
 * take another person's picture with it.
 */
const removeAvatarFile = async (avatarPath) => {
  const match = AVATAR_PATH.exec(String(avatarPath));
  if (!match) return;
  if ((await avatarReferences(avatarPath)) > 0) return;
  const fs = require('fs');
  const path = require('path');
  await fs.promises.unlink(path.join(__dirname, '../../../uploads/avatars', match[1]));
};

class UserService {
  async list(query, actor) {
    const { search, status, employeeType, departmentId, organizationId } = query;
    // Every other list caps its page size; this one joins five tables and took
    // any `limit` it was given.
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 20));
    const offset = (page - 1) * limit;

    const where = {};
    if (status) where.status = status;
    if (employeeType) where.employeeType = employeeType;
    if (departmentId) where.departmentId = departmentId;
    if (organizationId) where.organizationId = organizationId;

    if (search) {
      where[Op.or] = [
        // Escaped: a bare '%' or '_' would otherwise match every employee.
        { firstName: { [Op.iLike]: containsPattern(search) } },
        { lastName: { [Op.iLike]: containsPattern(search) } },
        { email: { [Op.iLike]: containsPattern(search) } },
      ];
    }

    const { rows, count } = await User.findAndCountAll({
      where,
      limit,
      offset,
      attributes: attributesFor(actor),
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

  async getById(id, actor) {
    const user = await User.findByPk(id, {
      attributes: attributesFor(actor, id),
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

  async create(data, actor) {
    const { password, sendInvite = true, roleId } = data;
    const rest = pickWritable(data);
    await assertRoleAssignable(actor, { role: rest.role, roleId });
    await assertReferencesInTenant(rest, roleId);
    await assertAvatarAvailable(rest.avatar, null);

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
      // Never "any tenant": the old fallback was `Tenant.findOne()`, which would
      // have filed the membership under whichever tenant came first.
      await AdGroupMember.create({ adGroupId: roleId, employeeId: user.id, tenantId: getTenantId() || user.tenantId });
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

  async update(id, data, actor) {
    const user = await User.findByPk(id);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    await assertMayManage(actor, user);
    const previousAvatar = user.avatar;
    const { roleId } = data;
    const rest = pickWritable(data);
    await assertRoleAssignable(actor, { role: rest.role, roleId });
    await assertReferencesInTenant(rest, roleId);
    // Keeping the picture you already have is always allowed; a new one must
    // not be someone else's.
    if (rest.avatar !== undefined && rest.avatar !== previousAvatar) {
      await assertAvatarAvailable(rest.avatar, user.id);
    }
    // Either field changes what this user may do, so any token they already
    // hold has to stop working.
    const accessChanged = rest.role !== undefined || roleId !== undefined;

    // One transaction, version bumped last. The bump used to come first and
    // outside any transaction, so a refresh landing between it and the
    // membership change minted a current-version token that still carried the
    // old role's permissions for up to an hour.
    await User.sequelize.transaction(async (transaction) => {
      await user.update(rest, { transaction });

      if (roleId !== undefined) {
        await AdGroupMember.destroy({ where: { employeeId: user.id }, transaction });
        if (roleId) {
          await AdGroupMember.create(
            { adGroupId: roleId, employeeId: user.id, tenantId: getTenantId() || user.tenantId },
            { transaction }
          );
        }
      }

      if (accessChanged) await bumpUser(user.id, transaction);
    });

    // A replaced avatar is otherwise kept on disk forever, which lets anyone
    // who can upload fill the disk by changing their picture repeatedly. Only a
    // server-issued avatar file is ever removed (the schema allows nothing else),
    // and only when no other account still uses it.
    if (previousAvatar && previousAvatar !== user.avatar) {
      await removeAvatarFile(previousAvatar).catch(() => {});
    }

    return user;
  }

  async delete(id, actor) {
    const user = await User.findByPk(id);

    if (!user) {
      throw new NotFoundError('User not found');
    }

    await assertMayManage(actor, user);

    await user.destroy();

    // Their documents' rows go with them (ON DELETE CASCADE), so the files must
    // too — nothing could ever list or serve them again. The id came from the
    // database, but it still becomes a path, so check its shape first.
    if (/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(String(user.id))) {
      const fs = require('fs');
      const path = require('path');
      const dir = path.join(__dirname, '../../../uploads/employees', String(user.id));
      await fs.promises.rm(dir, { recursive: true, force: true }).catch((error) => {
        console.error('Error removing employee documents:', error);
      });
    }
    return true;
  }
}

module.exports = { userService: new UserService() };
