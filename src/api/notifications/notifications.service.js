const { UniqueConstraintError, literal } = require('sequelize');
const { Notification } = require('./notification.model');
const { searchWhere } = require('../../utils/pagination');
const { NotFoundError } = require('../../core/AppError');

// Unread first, then most severe, then newest — the order someone triaging a
// morning's alerts actually wants.
const TRIAGE_ORDER = [
  [literal('"readAt" IS NOT NULL'), 'ASC'],
  [literal(`CASE "severity" WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END`), 'ASC'],
  [literal('"createdAt" DESC')],
];

class NotificationsService {
  /**
   * FR-M24-5: raising the same alert twice is a no-op.
   *
   * Idempotency is enforced by a unique (tenantId, dedupeKey) index rather than
   * a read-then-write check, so two job runs racing each other still produce
   * exactly one notification. The duplicate-key error is the expected path, not
   * an error condition.
   *
   * Returns the notification when newly created, or null when it already existed.
   */
  static async raise({ type, severity = 'MEDIUM', title, message, metadata = {}, factoryId, entityType, entityId, userId, dedupeKey }) {
    try {
      return await Notification.create({
        type, severity, title, message, metadata,
        factoryId: factoryId || null,
        entityType: entityType || null,
        entityId: entityId || null,
        userId: userId || null,
        dedupeKey: dedupeKey || `${type}:${entityId || 'global'}`,
      });
    } catch (error) {
      if (error instanceof UniqueConstraintError) return null; // already raised
      throw error;
    }
  }

  /** Raises many alerts, reporting how many were genuinely new. */
  static async raiseMany(alerts) {
    let created = 0;
    for (const alert of alerts) {
      const result = await this.raise(alert);
      if (result) created += 1;
    }
    return { attempted: alerts.length, created, suppressedAsDuplicate: alerts.length - created };
  }

  static async list(page, limit, { unreadOnly, type, severity, factoryId, search } = {}) {
    const offset = (page - 1) * limit;
    const where = {};
    if (unreadOnly === true || unreadOnly === 'true') where.readAt = null;
    if (type) where.type = type;
    if (severity) where.severity = severity;
    if (factoryId) where.factoryId = factoryId;
    if (search) Object.assign(where, searchWhere(search, ['title', 'message']));

    return Notification.findAndCountAll({ where, limit, offset, order: TRIAGE_ORDER });
  }

  static async unreadCount() {
    return Notification.count({ where: { readAt: null } });
  }

  static async markRead(id) {
    const notification = await Notification.findByPk(id);
    if (!notification) throw new NotFoundError('Notification not found');
    if (notification.readAt) return notification;
    return notification.update({ readAt: new Date() });
  }

  static async markAllRead() {
    const [count] = await Notification.update({ readAt: new Date() }, { where: { readAt: null } });
    return { markedRead: count };
  }

  /**
   * Clears the dedupe record for a condition that has resolved, so the alert
   * can fire again if it recurs. Without this a lot that becomes healthy and
   * later goes bad again would stay silent forever.
   */
  static async rearm(dedupeKey) {
    const rearmed = await Notification.destroy({ where: { dedupeKey } });
    return { rearmed };
  }
}

module.exports = { NotificationsService };
