const { Router } = require('express');
const { z } = require('zod');
const { getStats } = require('./dashboard.controller');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { validate } = require('../../middlewares/validate');

const dashboardRouter = Router();

const statsQuerySchema = z.object({ factoryId: z.string().uuid().optional() });

// Previously public (no auth) — that leaked cross-tenant aggregate counts and recent
// employee names/emails to unauthenticated callers, since the tenant-scoping hooks only
// filter queries when tenantScope has set a tenant on the request's CLS context.
//
// Intentionally not permission-gated beyond authentication: every role has a
// dashboard. What differs is its *content* — the controller omits the financial
// half entirely for users without VIEW_RATES (AC-14.1), rather than gating the
// whole route and leaving those users with no landing screen at all.
dashboardRouter.get('/stats', authenticate, tenantScope, auditContext, validate(statsQuerySchema, 'query'), getStats);

module.exports = { dashboardRouter };
