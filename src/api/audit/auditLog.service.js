const { AuditLog } = require('./auditLog.model');
const { User } = require('../users/user.model');

class AuditLogService {
  static async list(page, limit, { entityType, entityId, userId } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (entityType) where.entityType = entityType;
    if (entityId) where.entityId = entityId;
    if (userId) where.userId = userId;

    return AuditLog.findAndCountAll({
      where,
      limit,
      offset,
      order: [['createdAt', 'DESC']],
      include: [{ model: User, attributes: ['id', 'firstName', 'lastName', 'email'], required: false }],
    });
  }
}

module.exports = { AuditLogService };
