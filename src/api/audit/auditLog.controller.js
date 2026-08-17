const { asyncHandler } = require('../../core/asyncHandler');
const { AuditLogService } = require('./auditLog.service');
const { sendSuccess, sendList } = require('../../utils/response');

const listAuditLogs = asyncHandler(async (req, res) => {
  const { page, limit, entityType, entityId, userId, search } = req.query;
  const data = await AuditLogService.list(Number(page), Number(limit), { entityType, entityId, userId, search });
  sendList(res, req, data, 'Audit logs retrieved successfully');
});

module.exports = { listAuditLogs };
