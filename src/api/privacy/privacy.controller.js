const { asyncHandler } = require('../../core/asyncHandler');
const { sendSuccess, sendList } = require('../../utils/response');
const { ForbiddenError, ValidationError, NotFoundError } = require('../../core/AppError');
const { PrivacyService } = require('./privacy.service');
const { RequestsService } = require('./requests.service');
const { BreachService } = require('./breach.service');
const { RetentionService } = require('./retention.service');
const { ConsentRecord } = require('./privacy.model');
const { User } = require('../users/user.model');
const { Tenant } = require('../organization/tenant.model');
const { contentDisposition } = require('../../utils/contentDisposition');

const client = (req) => ({ ip: req.ip, userAgent: req.get('user-agent') });

/** The JSON a person gets for an access request, as a download. */
const sendExport = (res, data, label) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', contentDisposition(`personal-data-${label}.json`));
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).send(JSON.stringify(data, null, 2));
};

// ---------------------------------------------------------------- overview & profile

/** For the desk's organisation pickers. Only the owner reaches this. */
const listOrganisations = asyncHandler(async (req, res) => {
  const rows = await Tenant.findAll({ attributes: ['id', 'name', 'slug', 'status'], order: [['name', 'ASC']] });
  sendSuccess(res, rows, 'Organisations');
});

const overview = asyncHandler(async (req, res) => sendSuccess(res, await PrivacyService.overview(), 'Compliance overview'));
const getProfile = asyncHandler(async (req, res) => sendSuccess(res, await PrivacyService.getProfile(), 'Privacy contact'));
const updateProfile = asyncHandler(async (req, res) => sendSuccess(res, await PrivacyService.updateProfile(req.body), 'Privacy contact saved'));

// ---------------------------------------------------------------- notices

const listNotices = asyncHandler(async (req, res) => sendSuccess(res, await PrivacyService.listNotices(), 'Notices retrieved'));
const getNotice = asyncHandler(async (req, res) => sendSuccess(res, await PrivacyService.getNotice(req.params.id), 'Notice retrieved'));
const createNotice = asyncHandler(async (req, res) => sendSuccess(res, await PrivacyService.createNotice(req.body), 'Draft created', 201));
const updateNotice = asyncHandler(async (req, res) => sendSuccess(res, await PrivacyService.updateNotice(req.params.id, req.body), 'Draft saved'));
const publishNotice = asyncHandler(async (req, res) => sendSuccess(res, await PrivacyService.publishNotice(req.params.id), 'Notice published'));
const deleteNotice = asyncHandler(async (req, res) => sendSuccess(res, await PrivacyService.deleteNotice(req.params.id), 'Draft deleted'));

// ---------------------------------------------------------------- consents

const listConsents = asyncHandler(async (req, res) => {
  const { page, limit, ...filters } = req.query;
  sendList(res, req, await PrivacyService.listConsents(Number(page), Number(limit), filters), 'Consents retrieved');
});
const recordConsent = asyncHandler(async (req, res) =>
  sendSuccess(res, await PrivacyService.recordConsent(req.body, client(req)), 'Consent recorded', 201));
const withdrawConsent = asyncHandler(async (req, res) =>
  sendSuccess(res, await PrivacyService.withdrawConsent(req.params.id, { reason: req.body.reason }), 'Consent withdrawn'));

// ---------------------------------------------------------------- requests

const listRequests = asyncHandler(async (req, res) => {
  const { page, limit, openOnly, overdueOnly, ...filters } = req.query;
  const data = await RequestsService.list(Number(page), Number(limit), { ...filters, openOnly: openOnly === 'true', overdueOnly: overdueOnly === 'true' });
  sendList(res, req, data, 'Requests retrieved');
});
const getRequest = asyncHandler(async (req, res) => sendSuccess(res, RequestsService.view(await RequestsService.get(req.params.id)), 'Request retrieved'));
const createRequest = asyncHandler(async (req, res) => {
  const created = await RequestsService.create(req.body);
  sendSuccess(res, RequestsService.view(await RequestsService.get(created.id)), 'Request recorded', 201);
});
const updateRequest = asyncHandler(async (req, res) => sendSuccess(res, await RequestsService.update(req.params.id, req.body), 'Request updated'));
const verifyRequest = asyncHandler(async (req, res) => sendSuccess(res, await RequestsService.verifyIdentity(req.params.id, req.body.note), 'Identity verified'));
const rejectRequest = asyncHandler(async (req, res) => sendSuccess(res, await RequestsService.reject(req.params.id, req.body.reason), 'Request rejected'));
const completeRequest = asyncHandler(async (req, res) => {
  sendSuccess(res, await RequestsService.complete(req.params.id, req.body), 'Request completed');
});

/** Download for an access request: needs the request to be verified and linked. */
const exportForRequest = asyncHandler(async (req, res) => {
  const request = await RequestsService.get(req.params.id);
  if (!request.principalId) throw new ValidationError('Link the request to the person\'s record first');
  if (!request.identityVerifiedAt) throw new ValidationError("Verify the requester's identity before disclosing their data");
  const data = await RequestsService.compilePersonalData(request.principalType, request.principalId, request.tenantId);
  sendExport(res, data, request.requestNumber.replace(/\//g, '-'));
});

/** Direct export by record, for the Privacy Officer answering by post or email. */
const exportPrincipal = asyncHandler(async (req, res) => {
  const { principalType, principalId, tenantId } = req.query;
  sendExport(res, await RequestsService.compilePersonalData(principalType, principalId, tenantId), principalType.toLowerCase());
});

// ---------------------------------------------------------------- breaches

const listBreaches = asyncHandler(async (req, res) => sendSuccess(res, await BreachService.list(), 'Breaches retrieved'));
const getBreach = asyncHandler(async (req, res) => sendSuccess(res, await BreachService.getView(req.params.id), 'Breach retrieved'));
const createBreach = asyncHandler(async (req, res) => sendSuccess(res, await BreachService.create(req.body), 'Breach recorded', 201));
const updateBreach = asyncHandler(async (req, res) => sendSuccess(res, await BreachService.update(req.params.id, req.body), 'Breach updated'));
const breachStep = asyncHandler(async (req, res) => {
  const { step, ...rest } = req.body;
  sendSuccess(res, await BreachService.recordStep(req.params.id, step, rest), 'Recorded');
});
const closeBreach = asyncHandler(async (req, res) => sendSuccess(res, await BreachService.close(req.params.id), 'Breach closed'));
const breachReport = asyncHandler(async (req, res) => sendSuccess(res, await BreachService.report(req.params.id), 'Report drafted'));

// ---------------------------------------------------------------- retention

const listRetention = asyncHandler(async (req, res) => sendSuccess(res, await RetentionService.list(), 'Retention schedule'));
const updateRetention = asyncHandler(async (req, res) => sendSuccess(res, await RetentionService.update(req.params.id, req.body), 'Rule saved'));
const runRetention = asyncHandler(async (req, res) => sendSuccess(res, await RetentionService.run(req.params.id), 'Rule applied'));

// ---------------------------------------------------------------- self-service

const me = asyncHandler(async (req, res) => sendSuccess(res, await PrivacyService.myPrivacy(req.user.userId), 'Your privacy'));
const acknowledge = asyncHandler(async (req, res) =>
  sendSuccess(res, await PrivacyService.acknowledge(req.user.userId, client(req)), 'Notice acknowledged'));

const myConsentGrant = asyncHandler(async (req, res) => {
  const consent = await PrivacyService.recordConsent(
    { principalType: 'USER', principalId: req.user.userId, purposeCode: req.body.purposeCode, method: 'IN_APP' },
    client(req)
  );
  sendSuccess(res, consent, 'Consent given', 201);
});

const myConsentWithdraw = asyncHandler(async (req, res) => {
  const consent = await ConsentRecord.findByPk(req.params.id);
  // Someone else's consent is not found, not forbidden: the id says nothing.
  if (!consent || consent.principalType !== 'USER' || consent.principalId !== req.user.userId) {
    throw new NotFoundError('Consent record not found');
  }
  sendSuccess(res, await PrivacyService.withdrawConsent(consent.id, { reason: req.body.reason }), 'Consent withdrawn');
});

const myRequest = asyncHandler(async (req, res) => {
  const self = await User.findByPk(req.user.userId, { attributes: ['id', 'firstName', 'lastName', 'email'] });
  if (!self) throw new NotFoundError('User not found');
  const created = await RequestsService.create({
    type: req.body.type,
    details: req.body.details,
    channel: 'IN_APP',
    principalType: 'USER',
    principalId: req.user.userId,
    requesterName: [self.firstName, self.lastName].filter(Boolean).join(' ') || self.email,
    requesterEmail: self.email,
    requesterRelation: 'SELF',
    submittedByUserId: req.user.userId,
    selfVerified: true,
  });
  sendSuccess(res, created, 'Request submitted', 201);
});

const myNominee = asyncHandler(async (req, res) =>
  sendSuccess(res, await PrivacyService.setNominee('USER', req.user.userId, req.body.nominee), req.body.nominee ? 'Nominee saved' : 'Nominee removed'));

const myExport = asyncHandler(async (req, res) => {
  if (!req.user.userId) throw new ForbiddenError('Not signed in');
  sendExport(res, await RequestsService.compilePersonalData('USER', req.user.userId), 'me');
});

module.exports = {
  listOrganisations, overview, getProfile, updateProfile,
  listNotices, getNotice, createNotice, updateNotice, publishNotice, deleteNotice,
  listConsents, recordConsent, withdrawConsent,
  listRequests, getRequest, createRequest, updateRequest, verifyRequest, rejectRequest, completeRequest, exportForRequest, exportPrincipal,
  listBreaches, getBreach, createBreach, updateBreach, breachStep, closeBreach, breachReport,
  listRetention, updateRetention, runRetention,
  me, acknowledge, myConsentGrant, myConsentWithdraw, myRequest, myNominee, myExport,
};
