const { asyncHandler } = require('../../core/asyncHandler');
const { DashboardService } = require('./dashboard.service');
const { sendSuccess } = require('../../utils/response');
const { hasViewRates } = require('../../utils/fieldMasking');
const { getAllowedFactoryIds } = require('../../core/factoryAccess');
const { hasPermission } = require('../../middlewares/authorize');

/**
 * The assembled dashboard, remembered for a short while.
 *
 * Building it is 65 SQL round trips, and every open dashboard asks again every
 * few seconds — so two hundred people with the page open were ~430 queries a
 * second before anyone did any work. The figures are daily and monthly totals;
 * nobody can tell a 45-second-old answer from a live one, and the cache means
 * the two-hundredth viewer costs nothing.
 *
 * Keyed on everything that changes the answer: tenant, the plants in scope,
 * whether money is shown, and the exact permission set (each widget is
 * governed by a permission). In-process on purpose — at one or two instances
 * a shared cache buys nothing, and this can be swapped for Redis at the point
 * the audit says it is needed (docs/scalability-audit.md, Stage 3).
 */
const CACHE_TTL_MS = 45 * 1000;
const CACHE_MAX_ENTRIES = 500;
const cache = new Map();

const cacheKey = (req, factoryIds) => {
  const scope = factoryIds === null ? '*' : [...factoryIds].sort().join(',');
  const permissions = [...(req.user.permissions || [])].sort().join(',');
  return `${req.user.tenantId}|${scope}|${hasViewRates(req) ? 'rates' : 'norates'}|${req.user.role}|${permissions}`;
};

const remember = (key, data) => {
  if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
  cache.set(key, { data, expiresAt: Date.now() + CACHE_TTL_MS });
};

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
  // Each operational widget is governed by the same permission as the module
  // it summarises, so the landing page cannot become a way to read figures the
  // user could not open the module for.
  const key = cacheKey(req, factoryIds);
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    res.setHeader('X-Cache', 'HIT');
    return sendSuccess(res, hit.data, 'Dashboard retrieved successfully');
  }

  const data = await DashboardService.getDashboard({
    factoryIds,
    canViewRates: hasViewRates(req),
    can: (permission) => hasPermission(req.user, permission),
  });
  remember(key, data);
  res.setHeader('X-Cache', 'MISS');
  sendSuccess(res, data, 'Dashboard retrieved successfully');
});

/** For tests, and for anything that must see a fresh dashboard immediately. */
const clearDashboardCache = () => cache.clear();

module.exports = { getStats, clearDashboardCache };
