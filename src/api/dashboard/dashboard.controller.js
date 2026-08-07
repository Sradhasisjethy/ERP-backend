const { asyncHandler } = require('../../core/asyncHandler');
const { DashboardService } = require('./dashboard.service');
const { sendSuccess } = require('../../utils/response');

const getStats = asyncHandler(async (req, res) => {
  const stats = await DashboardService.getStats();
  sendSuccess(res, stats, 'Dashboard stats retrieved');
});

module.exports = { getStats };
