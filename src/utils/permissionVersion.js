const { Op } = require('sequelize');
const { sessionStateCache } = require('../core/sessionStateCache');

/**
 * Invalidates already-issued access tokens the moment a user's access changes.
 *
 * Permissions live in the token, and `authenticate` does no database work, so
 * without this a revocation was a promise about the future: it took effect when
 * the token expired, up to `JWT_ACCESS_EXPIRATION` later (1 hour by default).
 * For an ERP where roles gate money, approvals and other plants' data, "removed
 * their access, it'll apply within the hour" is not a revocation.
 *
 * Every function here bumps a counter that the token carries as a claim. The
 * cost is one indexed read per request in `authenticate`, which is what buys
 * the immediacy — a stateless token cannot be withdrawn by definition.
 *
 * Deliberately per-user, not per-tenant: a tenant-wide epoch would log every
 * employee out each time one role was edited.
 *
 * These are called from the write paths rather than from model hooks on
 * purpose. A hook on AdGroup would have to work out the membership itself on
 * every save, including saves that changed only a name, and the set of writes
 * that actually alter access is small and worth naming explicitly.
 */

/** Bumps one user. Used when their row itself changes (role, roleId). */
const bumpUser = async (userId, transaction) => {
  if (!userId) return;
  const { User } = require('../api/users/user.model');
  await User.increment('permissionsVersion', { by: 1, where: { id: userId }, transaction });
  // increment() runs no model hooks, so the cached answer is dropped here.
  sessionStateCache.invalidate(userId, transaction);
};

/** Bumps several users at once. */
const bumpUsers = async (userIds, transaction) => {
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length) return;
  const { User } = require('../api/users/user.model');
  await User.increment('permissionsVersion', { by: 1, where: { id: { [Op.in]: ids } }, transaction });
  sessionStateCache.invalidate(ids, transaction);
};

/**
 * Bumps everyone holding a role — for a permission edit, a deactivation or a
 * delete. Read before the change where the membership is about to disappear.
 */
const bumpRoleMembers = async (adGroupId, transaction) => {
  if (!adGroupId) return;
  const { AdGroupMember } = require('../api/roles/adGroupMember.model');
  const members = await AdGroupMember.findAll({
    where: { adGroupId },
    attributes: ['employeeId'],
    transaction,
  });
  await bumpUsers(members.map((m) => m.employeeId), transaction);
};

module.exports = { bumpUser, bumpUsers, bumpRoleMembers };
