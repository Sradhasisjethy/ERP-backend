const { Router } = require('express');
const { getStats } = require('./dashboard.controller');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');

const dashboardRouter = Router();

// Previously public (no auth) — that leaked cross-tenant aggregate counts and recent
// employee names/emails to unauthenticated callers, since the tenant-scoping hooks only
// filter queries when tenantScope has set a tenant on the request's CLS context.
dashboardRouter.get('/stats', authenticate, tenantScope, getStats);

module.exports = { dashboardRouter };
