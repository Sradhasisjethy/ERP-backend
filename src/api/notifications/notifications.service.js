const { UniqueConstraintError, literal, Op } = require('sequelize');
const { Notification } = require('./notification.model');
const { searchWhere } = require('../../utils/pagination');
const { NotFoundError } = require('../../core/AppError');

// Keeps a query well-formed and empty when the user can see no factory at all,
// rather than matching everything. Same device as core/factoryAccess.js.
const NO_MATCH_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * The permission that governs the data each alert is *about*.
 *
 * A broadcast notification (`userId: null`) goes to everyone who can see the
 * factory, which is right for "this lot finished curing" and quite wrong for
 * "this customer has breached their credit limit". The audience filter alone
 * still handed a Masters-only clerk the tenant's overdue receivables, negative
 * cash position and credit breaches, because those are broadcasts.
 *
 * An alert is a summary of a record, so it is gated by the same permission as
 * the record. A type absent from this map is treated as personal-only and needs
 * no module grant — the safe direction for a type added later without thought.
 */
const ALERT_PERMISSIONS = Object.freeze({
  NEGATIVE_STOCK: 'INVENTORY_READ',
  DEAD_STOCK: 'INVENTORY_READ',
  NEAR_DEAD_STOCK: 'INVENTORY_READ',
  REORDER_LEVEL: 'INVENTORY_READ',
  CURING_COMPLETE: 'INVENTORY_READ',
  EARLY_CURING_RELEASE: 'PRODUCTION_READ',
  VARIANCE_APPROVAL_PENDING: 'PRODUCTION_APPROVE_VARIANCE',
  CREDIT_LIMIT_BREACH: 'SALES_READ',
  ORDER_PAST_DELIVERY_DATE: 'SALES_READ',
  STALE_RESERVATION: 'SALES_READ',
  OVERDUE_RECEIVABLE: 'RECEIPT_READ',
  NEGATIVE_CASH: 'LEDGER_READ',
  LEDGER_BALANCE_DRIFT: 'LEDGER_READ',
  JOB_FAILED: 'SETTINGS_READ',
});

/** Alert types this caller may see at all. */
const permittedTypes = (can) =>
  Object.keys(ALERT_PERMISSIONS).filter((type) => can(ALERT_PERMISSIONS[type]));

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
  static async raise({ type, severity = 'MEDIUM', title, message, metadata = {}, factoryId, entityType, entityId, userId, dedupeKey, transaction }) {
    try {
      // `transaction` is honoured so a notification raised by a business
      // service commits with the document that caused it — and rolls back with
      // it, rather than announcing an event that never happened.
      return await Notification.create(
        {
          type, severity, title, message, metadata,
          factoryId: factoryId || null,
          entityType: entityType || null,
          entityId: entityId || null,
          userId: userId || null,
          dedupeKey: dedupeKey || `${type}:${entityId || 'global'}`,
        },
        { transaction }
      );
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

  /**
   * Which notifications this caller is entitled to see at all.
   *
   * Two rules, taken straight from the model's own columns:
   *
   *   userId    null means broadcast, set means personal (notification.model.js).
   *             So: mine, or everyone's — never another named user's.
   *   factoryId null means tenant-wide, set means plant-specific. BR-29 says a
   *             user assigned to one plant does not see another's, so the
   *             factory restriction applies here exactly as it does to every
   *             other list.
   *
   * None of this was applied before. `list` built its `where` from the query
   * filters alone, so omitting `?factoryId=` returned every plant's and every
   * user's alerts — and `enforceFactoryScope` on the router could not catch it,
   * because that middleware only refuses a factory the caller *names*. The
   * alerts carry credit-limit breaches, overdue receivables and negative cash
   * positions, so this was a read of exactly the commercial figures BR-07 exists
   * to contain.
   *
   * A third rule lives in ALERT_PERMISSIONS above: a broadcast is still a
   * summary of a record, so the caller needs the grant for that record's module.
   * Applied here rather than in `list` so the count, the read and the read-all
   * all inherit it — an alert you may not see is also one you may not clear.
   *
   * @param {{userId: string, allowedFactoryIds: string[]|null, can: Function}} audience
   *   `allowedFactoryIds` of null means unrestricted (a bypass role).
   *   `can` omitted means unrestricted, for internal callers such as the jobs.
   */
  static audienceWhere({ userId, allowedFactoryIds, can } = {}) {
    const clauses = [{ [Op.or]: [{ userId: null }, { userId: userId || NO_MATCH_UUID }] }];

    if (allowedFactoryIds !== null && allowedFactoryIds !== undefined) {
      clauses.push({
        [Op.or]: [
          { factoryId: null },
          { factoryId: { [Op.in]: allowedFactoryIds.length ? allowedFactoryIds : [NO_MATCH_UUID] } },
        ],
      });
    }

    if (typeof can === 'function') {
      // A personal alert reaches its addressee whatever their module grants —
      // it was raised for them by name. A broadcast needs the module grant.
      clauses.push({
        [Op.or]: [
          { userId: userId || NO_MATCH_UUID },
          { type: { [Op.in]: permittedTypes(can) } },
        ],
      });
    }

    return { [Op.and]: clauses };
  }

  static async list(page, limit, { unreadOnly, type, severity, factoryId, search } = {}, audience = {}) {
    const offset = (page - 1) * limit;
    const where = { ...this.audienceWhere(audience) };
    if (unreadOnly === true || unreadOnly === 'true') where.readAt = null;
    if (type) where.type = type;
    if (severity) where.severity = severity;
    if (factoryId) where.factoryId = factoryId;
    if (search) Object.assign(where, searchWhere(search, ['title', 'message']));

    return Notification.findAndCountAll({ where, limit, offset, order: TRIAGE_ORDER });
  }

  static async unreadCount(audience = {}) {
    return Notification.count({ where: { ...this.audienceWhere(audience), readAt: null } });
  }

  static async markRead(id, audience = {}) {
    // Scoped find, not findByPk: reading someone else's alert by id and marking
    // it read was previously a one-request operation for any logged-in user.
    const notification = await Notification.findOne({
      where: { ...this.audienceWhere(audience), id },
    });
    if (!notification) throw new NotFoundError('Notification not found');
    if (notification.readAt) return notification;
    return notification.update({ readAt: new Date() });
  }

  static async markAllRead(audience = {}) {
    // Was tenant-wide: one call from any authenticated user cleared every
    // unread alert for every user in the tenant.
    const [count] = await Notification.update(
      { readAt: new Date() },
      { where: { ...this.audienceWhere(audience), readAt: null } }
    );
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
