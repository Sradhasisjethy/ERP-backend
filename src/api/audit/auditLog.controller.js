const { asyncHandler } = require('../../core/asyncHandler');
const { AuditLogService } = require('./auditLog.service');
const { sendList } = require('../../utils/response');

const listAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit, entityType, entityId, userId, search } = req.query;
  // The viewer goes to the query so rows they cannot read are never counted,
  // and each returned row is then redacted to what their grants allow.
  const data = await AuditLogService.list(Number(page), Number(limit), { entityType, entityId, userId, search }, req.user);
  sendList(res, req, { ...data, rows: data.rows.map((row) => AuditLogService.redactRow(row, req)) }, 'Audit logs retrieved successfully');
});

module.exports = { listAuditLogs };
