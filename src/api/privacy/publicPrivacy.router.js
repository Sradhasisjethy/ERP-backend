const { Router } = require('express');
const rateLimit = require('express-rate-limit');
const { asyncHandler } = require('../../core/asyncHandler');
const { validate } = require('../../middlewares/validate');
const { sendSuccess } = require('../../utils/response');
const { NotFoundError } = require('../../core/AppError');
const { PrivacyService } = require('./privacy.service');
const { RequestsService } = require('./requests.service');
const { publicRequestSchema } = require('./privacy.schema');
const { logger } = require('../../utils/logger');
const { platformContext } = require('../../core/platformOwner');

/**
 * /api/v1/public/privacy — no sign-in.
 *
 * The application owner's privacy notice, which the login page links to, and
 * the form for making a request. Most people whose data the ERP holds will
 * never have a login (labourers, walk-in customers, people who once phoned in
 * an enquiry); the Act still gives them the right to read the notice, reach
 * the privacy contact and make a request (s.5, s.8(9), ss.11-14).
 *
 * There is one notice for the whole platform, so there is nothing to choose
 * and nothing about any organisation to enumerate. A request is accepted
 * without anything being disclosed back: the reply goes to the contact details
 * given, after the owner has checked who is asking.
 */
const publicPrivacyRouter = Router();
// No organisation in context: a request from here belongs to none until the owner says so.
publicPrivacyRouter.use(platformContext);

const production = process.env.NODE_ENV === 'production';
const submitLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: production ? 5 : 1000,
  standardHeaders: true,
  legacyHeaders: false,
  handler: (req, res) => res.status(429).json({ success: false, message: 'Too many requests from this address. Please try again in an hour.' }),
});

const publicView = async () => {
  const notice = await PrivacyService.getPublishedNotice();
  if (!notice) throw new NotFoundError('No privacy notice has been published yet');
  const profile = await PrivacyService.getProfile();
  return {
    contact: {
      name: profile.contactName || null,
      designation: profile.contactDesignation || null,
      email: profile.contactEmail || null,
      phone: profile.contactPhone || null,
      postalAddress: profile.postalAddress || null,
    },
    responseDays: profile.responseDays,
    dataLocation: profile.dataLocation || null,
    notice: {
      version: notice.version,
      title: notice.title,
      language: notice.language,
      summary: notice.summary,
      body: notice.body,
      purposes: notice.purposes,
      processors: notice.processors,
      publishedAt: notice.publishedAt,
    },
  };
};

publicPrivacyRouter.get('/', asyncHandler(async (req, res) => {
  sendSuccess(res, await publicView(), 'Privacy notice');
}));

publicPrivacyRouter.post('/requests', submitLimiter, validate(publicRequestSchema), asyncHandler(async (req, res) => {
  // Nothing to answer requests against until a notice and contact exist.
  await publicView();
  const { website, ...body } = req.body;
  if (website) {
    // Bots fill every field. Answer as if it worked; store nothing.
    logger.info({ message: 'Public privacy form: honeypot filled, request dropped' });
    return sendSuccess(res, { reference: null }, 'Request received', 201);
  }
  const created = await RequestsService.create({ ...body, channel: 'PUBLIC_FORM' });
  // The reference and due date only: nothing about any record is disclosed here.
  sendSuccess(res, { reference: created.requestNumber, dueDate: created.dueDate }, 'Request received', 201);
}));

module.exports = { publicPrivacyRouter };
