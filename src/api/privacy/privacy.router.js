const { Router } = require('express');
const { authenticate } = require('../../middlewares/auth');
const { tenantScope } = require('../../middlewares/tenantScope');
const { auditContext } = require('../../middlewares/auditContext');
const { validate } = require('../../middlewares/validate');
const { requirePlatformOwner, platformContext } = require('../../core/platformOwner');
const controller = require('./privacy.controller');
const schema = require('./privacy.schema');

/**
 * /api/v1/privacy — DPDP Act compliance.
 *
 * Two audiences, two routers.
 *
 * `/me/*` is every signed-in user acting on their own record, inside their own
 * organisation, with no grant needed: a right under the Act is not something
 * a role administrator can take away.
 *
 * Everything else is the privacy desk, which belongs to the application owner
 * — the accounts named in PLATFORM_OWNER_EMAILS — and reads across every
 * organisation. It is deliberately not permission-gated: authorize() lets
 * PLATFORM_ADMIN and TENANT_OWNER through everything, and those are the
 * organisations' own administrators.
 */
const privacyRouter = Router();
privacyRouter.use(authenticate);

const me = Router();
me.use(tenantScope, auditContext);
me.get('/', controller.me);
me.post('/acknowledge', controller.acknowledge);
me.post('/consents', validate(schema.myConsentSchema), controller.myConsentGrant);
me.put('/consents/:id/withdraw', validate(schema.withdrawSchema), controller.myConsentWithdraw);
me.post('/requests', validate(schema.myRequestSchema), controller.myRequest);
me.put('/nominee', validate(schema.myNomineeSchema), controller.myNominee);
me.get('/export', controller.myExport);
privacyRouter.use('/me', me);

const desk = Router();
desk.use(requirePlatformOwner, platformContext);

desk.get('/overview', controller.overview);
desk.get('/organisations', controller.listOrganisations);
desk.get('/profile', controller.getProfile);
desk.put('/profile', validate(schema.profileSchema), controller.updateProfile);

desk.get('/notices', controller.listNotices);
desk.post('/notices', validate(schema.createNoticeSchema), controller.createNotice);
desk.get('/notices/:id', controller.getNotice);
desk.put('/notices/:id', validate(schema.updateNoticeSchema), controller.updateNotice);
desk.post('/notices/:id/publish', controller.publishNotice);
desk.delete('/notices/:id', controller.deleteNotice);

desk.get('/consents', validate(schema.consentListSchema, 'query'), controller.listConsents);
desk.post('/consents', validate(schema.consentSchema), controller.recordConsent);
desk.put('/consents/:id/withdraw', validate(schema.withdrawSchema), controller.withdrawConsent);

// Fixed paths before /requests/:id.
desk.get('/requests', validate(schema.requestListSchema, 'query'), controller.listRequests);
desk.post('/requests', validate(schema.createRequestSchema), controller.createRequest);
desk.get('/export', validate(schema.exportQuerySchema, 'query'), controller.exportPrincipal);
desk.get('/requests/:id', controller.getRequest);
desk.put('/requests/:id', validate(schema.updateRequestSchema), controller.updateRequest);
desk.post('/requests/:id/verify', validate(schema.verifySchema), controller.verifyRequest);
desk.post('/requests/:id/reject', validate(schema.rejectSchema), controller.rejectRequest);
desk.post('/requests/:id/complete', validate(schema.completeSchema), controller.completeRequest);
desk.get('/requests/:id/export', controller.exportForRequest);

desk.get('/breaches', controller.listBreaches);
desk.post('/breaches', validate(schema.createBreachSchema), controller.createBreach);
desk.get('/breaches/:id', controller.getBreach);
desk.put('/breaches/:id', validate(schema.updateBreachSchema), controller.updateBreach);
desk.post('/breaches/:id/steps', validate(schema.breachStepSchema), controller.breachStep);
desk.post('/breaches/:id/close', controller.closeBreach);
desk.get('/breaches/:id/report', controller.breachReport);

desk.get('/retention', controller.listRetention);
desk.put('/retention/:id', validate(schema.retentionUpdateSchema), controller.updateRetention);
desk.post('/retention/:id/run', controller.runRetention);

privacyRouter.use('/', desk);

module.exports = { privacyRouter };
