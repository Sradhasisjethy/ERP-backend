const { asyncHandler } = require('../../core/asyncHandler');
const { NotificationsService } = require('./notifications.service');
const { sendSuccess, sendList } = require('../../utils/response');
const { hasViewRates } = require('../../utils/fieldMasking');
const { getAllowedFactoryIds } = require('../../core/factoryAccess');
const { hasPermission } = require('../../middlewares/authorize');

/**
 * Who the caller is, for the audience filter every read and write below applies.
 * Resolved per request because factory access is many-to-many — there is no one
 * "current factory" to hold in CLS.
 */
const audienceFor = async (req) => ({
  userId: req.user.userId,
  allowedFactoryIds: await getAllowedFactoryIds(req),
  // Broadcast alerts summarise records; the caller needs the record's grant.
  can: (permission) => hasPermission(req.user, permission),
});

// BR-27: alert metadata can carry money (an overdue amount, a cash balance).
// Prose is written money-free by the jobs, so masking the metadata bag is
// sufficient — and it's applied here rather than trusted to each job.
const MONEY_KEYS = ['outstandingPaise', 'balancePaise', 'valuePaise', 'amountPaise', 'creditLimitPaise'];

const maskMetadata = (rows, req) => {
  if (hasViewRates(req)) return rows;
  return rows.map((row) => {
    const plain = typeof row.toJSON === 'function' ? row.toJSON() : row;
    const metadata = { ...(plain.metadata || {}) };
    for (const key of MONEY_KEYS) if (key in metadata) metadata[key] = null;
    return { ...plain, metadata };
  });
};

const list = asyncHandler(async (req, res) => {
  const { page, limit, unreadOnly, type, severity, factoryId, search } = req.query;
  const data = await NotificationsService.list(
    Number(page),
    Number(limit),
    { unreadOnly, type, severity, factoryId, search },
    await audienceFor(req)
  );
  sendList(res, req, { ...data, rows: maskMetadata(data.rows, req) }, 'Notifications retrieved successfully');
});

const unreadCount = asyncHandler(async (req, res) => {
  const unread = await NotificationsService.unreadCount(await audienceFor(req));
  sendSuccess(res, { unread }, 'Unread count retrieved successfully');
});

const markRead = asyncHandler(async (req, res) => {
  const data = await NotificationsService.markRead(req.params.id, await audienceFor(req));
  sendSuccess(res, data, 'Notification marked read');
});

const markAllRead = asyncHandler(async (req, res) => {
  const data = await NotificationsService.markAllRead(await audienceFor(req));
  sendSuccess(res, data, 'All notifications marked read');
});

module.exports = { list, unreadCount, markRead, markAllRead };
