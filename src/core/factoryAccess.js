const { Op } = require('sequelize');
const { SystemRoles } = require('../utils/constants');
const { ForbiddenError } = require('./AppError');

// Same bypass list authorize.js uses for permission checks — platform/tenant
// admins are not restricted to specific factories.
const FACTORY_BYPASS_ROLES = [SystemRoles.PLATFORM_ADMIN, SystemRoles.TENANT_OWNER];

/**
 * Resolves which factories the current user may see.
 * Returns `null` to mean "unrestricted" (bypass roles), otherwise an array of
 * factory ids (possibly empty, meaning the user has no factory assigned).
 *
 * Factory access is many-to-many (a manager can be assigned to several
 * factories), which is why this is a per-request lookup rather than a single
 * CLS value like tenantId — there is no one "current factory" to inject globally.
 */
const getAllowedFactoryIds = async (req) => {
  if (FACTORY_BYPASS_ROLES.includes(req.user.role)) return null;

  const { UserFactory } = require('../api/factory/userFactory.model');
  const rows = await UserFactory.findAll({ where: { userId: req.user.userId }, attributes: ['factoryId'] });
  return rows.map((r) => r.factoryId);
};

/**
 * Applies factory scoping to a Sequelize `where` clause in place, honouring
 * BR-29 (cross-factory data never returned without explicit permission).
 * @param {object} where
 * @param {string[]|null} allowedFactoryIds - result of getAllowedFactoryIds
 * @param {string} [requestedFactoryId] - an explicit ?factoryId= filter, if any
 */
const applyFactoryFilter = (where, allowedFactoryIds, requestedFactoryId) => {
  if (allowedFactoryIds === null) {
    if (requestedFactoryId) where.factoryId = requestedFactoryId;
    return where;
  }

  if (requestedFactoryId) {
    if (!allowedFactoryIds.includes(requestedFactoryId)) {
      throw new ForbiddenError('You do not have access to this factory');
    }
    where.factoryId = requestedFactoryId;
    return where;
  }

  // No specific factory requested: restrict to every factory the user can see.
  // An impossible UUID keeps the query well-formed (and empty) when the user
  // has no factories assigned, instead of accidentally matching everything.
  where.factoryId = { [Op.in]: allowedFactoryIds.length ? allowedFactoryIds : ['00000000-0000-0000-0000-000000000000'] };
  return where;
};

const assertFactoryAccess = (allowedFactoryIds, factoryId) => {
  if (allowedFactoryIds === null) return;
  if (!allowedFactoryIds.includes(factoryId)) {
    throw new ForbiddenError('You do not have access to this factory');
  }
};

module.exports = { getAllowedFactoryIds, applyFactoryFilter, assertFactoryAccess, FACTORY_BYPASS_ROLES };
