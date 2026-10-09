const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const path = require('path');
const { env } = require('./config/env');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');
const { apiLimiter } = require('./middlewares/rateLimiter');
const { financialDoubleSubmitGuard } = require('./middlewares/idempotency');
const { logger } = require('./utils/logger');

// Domain Routers
const { authRouter } = require('./api/auth/auth.router');
const { userRouter } = require('./api/users/user.router');
const { organizationRouter } = require('./api/organization/organization.router');
const { roleRouter } = require('./api/roles/role.router');
const { settingsRouter } = require('./api/settings/settings.router');
const { dashboardRouter } = require('./api/dashboard/dashboard.router');
const { factoryRouter } = require('./api/factory/factory.router');
const { documentSeriesRouter } = require('./api/documentSeries/documentSeries.router');
const { auditLogRouter } = require('./api/audit/auditLog.router');
const { productsRouter } = require('./api/products/products.router');
const { partiesRouter } = require('./api/parties/parties.router');
const { vehiclesRouter } = require('./api/vehicles/vehicles.router');
const { pricingRouter } = require('./api/pricing/pricing.router');
const { inventoryRouter } = require('./api/inventory/inventory.router');
const { purchasingRouter } = require('./api/purchasing/purchasing.router');
const { transferRouter } = require('./api/transfer/transfer.router');
const { salesRouter } = require('./api/sales/sales.router');
const { bundlesRouter } = require('./api/bundles/bundles.router');
const { productionRouter } = require('./api/production/production.router');
const { qualityRouter } = require('./api/quality/quality.router');
const { dispatchRouter } = require('./api/dispatch/dispatch.router');
const { ledgerRouter } = require('./api/ledger/ledger.router');
const { invoicingRouter } = require('./api/invoicing/invoicing.router');
const { retailRouter } = require('./api/retail/retail.router');
const { returnsRouter } = require('./api/returns/returns.router');
const { paymentsRouter } = require('./api/payments/payments.router');
const { workforceRouter } = require('./api/workforce/workforce.router');
const { expensesRouter } = require('./api/expenses/expenses.router');
const { fixedAssetsRouter } = require('./api/assets/fixedAssets.router');
const { quotationsRouter } = require('./api/quotations/quotations.router');
const { cashRegisterRouter } = require('./api/cashRegister/cashRegister.router');
const { hrRouter } = require('./api/hr/hr.router');
const { crmRouter } = require('./api/crm/crm.router');
const { gstrRouter } = require('./api/gstr/gstr.router');
const { analyticsRouter } = require('./api/analytics/analytics.router');
const { reportsRouter } = require('./api/reports/reports.router');
const { notificationsRouter } = require('./api/notifications/notifications.router');
const { migrationRouter } = require('./api/migration/migration.router');
const { masterDataRouter } = require('./api/masterData/masterData.router');
require('./models/index');

const app = express();

/**
 * How many reverse-proxy hops sit in front of this process.
 *
 * Every rate limiter buckets on req.ip. With no trust-proxy setting, a
 * deployment behind nginx or an ALB sees the proxy's address on every request:
 * all traffic shares one bucket, so the login limiter locks out the entire
 * customer after ten failed attempts by anyone, while an attacker gets the same
 * ten. Setting the real hop count makes req.ip the client again.
 *
 * The value is explicit rather than `true`. Express's `true` trusts the whole
 * X-Forwarded-For chain, which lets a client prepend an address of its choosing
 * and mint itself a fresh rate-limit bucket per request — express-rate-limit
 * refuses to start under that setting for exactly this reason.
 */
app.set('trust proxy', env.TRUST_PROXY_HOPS);

// Security Middlewares
app.use(helmet());
// A page of two hundred parties is ~150 KB of JSON; gzip makes it ~20 KB. This
// is the cheapest bandwidth win there is, and it costs a few hundred
// microseconds per response.
app.use(compression());
const allowedOrigins = env.CORS_ORIGIN
  ? env.CORS_ORIGIN.split(',').map((o) => o.trim())
  : ['http://localhost:3000'];

// Development used to accept *any* origin, with credentials. NODE_ENV defaults
// to development, so a deployment that forgot to set it let every website on
// the internet make authenticated calls with a visitor's cookies. Development
// now adds only the local machine to the configured list.
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/;

const isOriginAllowed = (origin) => {
  if (!origin) return true;
  if (allowedOrigins.includes(origin)) return true;
  if (env.NODE_ENV === 'development' && LOCAL_ORIGIN.test(origin)) return true;
  return allowedOrigins.some((allowed) => {
    if (allowed.includes('*')) {
      const escaped = allowed.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      return new RegExp(`^${escaped}$`).test(origin);
    }
    return false;
  });
};

app.use(
  cors({
    origin: (origin, callback) => {
      if (isOriginAllowed(origin)) {
        return callback(null, true);
      }
      // Tagged so the error handler answers 403, not 500. The origin is not
      // put in the message: it is caller-controlled text headed for the logs.
      const refused = new Error('Origin not allowed by CORS');
      refused.code = 'CORS_ORIGIN_REJECTED';
      return callback(refused);
    },
    credentials: true,
  })
);
app.use(apiLimiter);

// Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

/**
 * NUL bytes are refused at the door. No field in this application has a use
 * for U+0000, Postgres text cannot hold it, and Sequelize's literal escaping
 * turns it into a backslash and a zero — a party named "a<NUL>b" was stored as
 * "a", backslash, "0", "b" rather than refused. One check here covers every route, including
 * the few without a schema.
 */
const hasNul = (value, depth = 0) => {
  if (typeof value === 'string') return value.includes('\u0000');
  if (!value || typeof value !== 'object' || depth > 20) return false;
  return Object.entries(value).some(([k, v]) => k.includes('\u0000') || hasNul(v, depth + 1));
};
app.use((req, res, next) => {
  if (hasNul(req.body) || hasNul(req.query)) {
    return res.status(400).json({ success: false, message: 'The request contains a NUL character, which is not allowed.' });
  }
  next();
});

// A double click on "Save" used to post two receipts, vouchers or expenses.
// Identical POSTs to a financial create from the same user within 30 seconds
// are answered with the first response instead of creating a second document
// (see middlewares/idempotency.js). Needs the parsed body and cookies, so it
// sits after the parsers; it reads the user from the token itself.
app.use(financialDoubleSubmitGuard);

// Logging
//
// Apache "combined" minus two fields. The query string is dropped because
// searches carry personal data (`?search=` matches Aadhaar numbers and phones)
// and every request was being written to the log with it. The referrer is
// dropped because a page URL can carry a token — the reset-password page's does.
morgan.token('path-only', (req) => (req.originalUrl || req.url || '').split('?')[0]);
const ACCESS_LOG_FORMAT =
  ':remote-addr - :remote-user [:date[clf]] ":method :path-only HTTP/:http-version" :status :res[content-length] ":user-agent"';
app.use(
  morgan(ACCESS_LOG_FORMAT, {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

/**
 * Liveness: is the process up? Deliberately touches nothing — a liveness probe
 * that queries the database restarts a healthy process whenever the database
 * hiccups.
 */
app.get('/health/live', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

/**
 * Local uploads, served per-directory rather than as one open tree.
 *
 * This was `app.use('/uploads', express.static(...))`, mounted ahead of every
 * router, so the whole directory was public: no authentication, no tenant
 * check. `uploads/employees/` holds offer letters, contracts and ID scans, and
 * the permission check on the document *list* only decided who was told the
 * address — once known, the file was readable by anyone, from any tenant,
 * logged in or not, forever.
 *
 * Employee documents now go through GET /api/v1/users/:id/documents/:id/file,
 * which applies the same grant as the list and streams them as attachments.
 * What stays here is what is genuinely public or near-harmless: the brand marks
 * the login page needs before anyone has a session, and avatars.
 */
//
// Both directories are served from the API's own origin, so anything a browser
// would execute must never come out of them: only raster images are served,
// with nosniff and a CSP that sandboxes the response and forbids script even if
// a file were opened directly. An avatar uploaded before the upload filter was
// tightened with an .html/.svg/.js name is therefore a 404, not a page.
const SERVABLE_IMAGE = /\.(png|jpe?g|webp)$/i;
const serveImagesOnly = (dir) => [
  (req, res, next) => (SERVABLE_IMAGE.test(req.path) ? next() : res.status(404).end()),
  express.static(dir, {
    dotfiles: 'deny',
    index: false,
    setHeaders: (res) => {
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; sandbox");
    },
  }),
];
app.use('/uploads/assets', ...serveImagesOnly(path.join(__dirname, '../uploads/assets')));
app.use('/uploads/avatars', ...serveImagesOnly(path.join(__dirname, '../uploads/avatars')));

/**
 * Readiness: can this instance actually serve traffic?
 *
 * The previous /health returned `{status:'ok'}` unconditionally, so an instance
 * whose database connection was gone stayed in the load-balancer rotation and
 * kept accepting requests it could only fail. Returns 503 when a dependency is
 * down so the orchestrator can route around it.
 */
app.get(['/health', '/health/ready'], async (req, res) => {
  const { sequelize } = require('./config/database');
  const checks = {};
  try {
    await sequelize.authenticate();
    checks.database = 'ok';
  } catch (error) {
    checks.database = 'unreachable';
    logger.error({ message: 'Health check: database unreachable', error: error.message });
  }

  const healthy = Object.values(checks).every((v) => v === 'ok');
  res.status(healthy ? 200 : 503).json({
    status: healthy ? 'ok' : 'degraded',
    checks,
    uptimeSeconds: Math.round(process.uptime()),
    timestamp: new Date().toISOString(),
  });
});

// API Routes — v1
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1', organizationRouter); // Mounts /organizations, /offices, /departments
app.use('/api/v1/roles', roleRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/dashboard', dashboardRouter);
app.use('/api/v1', factoryRouter); // Mounts /factories, /financial-years
app.use('/api/v1/document-series', documentSeriesRouter);
app.use('/api/v1/audit-logs', auditLogRouter);
app.use('/api/v1', productsRouter); // Mounts /uoms, /product-categories, /hsn-codes, /products, /mix-designs
app.use('/api/v1/parties', partiesRouter);
app.use('/api/v1/vehicles', vehiclesRouter);
app.use('/api/v1/price-lists', pricingRouter);
app.use('/api/v1/inventory', inventoryRouter);
app.use('/api/v1/purchasing', purchasingRouter);
app.use('/api/v1/transfers', transferRouter);
app.use('/api/v1/sales', salesRouter);
app.use('/api/v1/quotations', quotationsRouter);
app.use('/api/v1/crm', crmRouter); // Leads and follow-ups
app.use('/api/v1/bundles', bundlesRouter);
app.use('/api/v1/production', productionRouter);
app.use('/api/v1/quality', qualityRouter);
app.use('/api/v1/dispatch', dispatchRouter);
app.use('/api/v1/ledger', ledgerRouter);
app.use('/api/v1/invoices', invoicingRouter);
app.use('/api/v1/retail', retailRouter); // Mounts /counter-sales (B2C)
app.use('/api/v1/cash-register', cashRegisterRouter);
app.use('/api/v1/returns', returnsRouter);
app.use('/api/v1', paymentsRouter); // Mounts /receipts, /payments
app.use('/api/v1/workforce', workforceRouter);
app.use('/api/v1/hr', hrRouter); // Staff leave and attendance (salaried, not daily wage)
app.use('/api/v1/expenses', expensesRouter);
app.use('/api/v1/fixed-assets', fixedAssetsRouter);
app.use('/api/v1/gstr', gstrRouter);
app.use('/api/v1/analytics', analyticsRouter);
app.use('/api/v1/reports', reportsRouter);
app.use('/api/v1/notifications', notificationsRouter);
app.use('/api/v1/migration', migrationRouter);
// Excel import/export for every master, one route set for all of them
app.use('/api/v1/master-data', masterDataRouter);

// Unmatched routes -> JSON 404 (must come after all routes, before the error handler)
app.use(notFoundHandler);

// Global Error Handler (must be last)
app.use(errorHandler);

module.exports = { app };
