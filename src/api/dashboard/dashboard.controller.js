const { asyncHandler } = require('../../core/asyncHandler');
const { DashboardService } = require('./dashboard.service');
const { sendSuccess } = require('../../utils/response');
const { hasViewRates } = require('../../utils/fieldMasking');
const { getAllowedFactoryIds } = require('../../core/factoryAccess');

const getStats = asyncHandler(async (req, res) => {
  // BR-29: a user only ever sees their assigned factories. `null` means the
  // caller has cross-factory visibility.
  const allowed = await getAllowedFactoryIds(req);
  const requested = req.query.factoryId;

  // An explicit ?factoryId= must still be inside what the user may see.
  let factoryIds = allowed;
  if (requested) {
    if (allowed !== null && !allowed.includes(requested)) {
      factoryIds = []; // deliberately empty -> the dashboard shows nothing
    } else {
      factoryIds = [requested];
    }
  }

  // AC-14.1: the financial half is not computed at all for a user without
  // VIEW_RATES, so the response literally has no financial figures to inspect.
  const data = await DashboardService.getDashboard({ factoryIds, canViewRates: hasViewRates(req) });
  sendSuccess(res, data, 'Dashboard retrieved successfully');
});

module.exports = { getStats };
