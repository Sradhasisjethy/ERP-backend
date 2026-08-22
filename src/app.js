const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
const path = require('path');
const { env } = require('./config/env');
const { errorHandler, notFoundHandler } = require('./middlewares/errorHandler');
const { apiLimiter } = require('./middlewares/rateLimiter');
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
const { pricingRouter } = require('./api/pricing/pricing.router');
const { inventoryRouter } = require('./api/inventory/inventory.router');
const { purchasingRouter } = require('./api/purchasing/purchasing.router');
const { transferRouter } = require('./api/transfer/transfer.router');
const { salesRouter } = require('./api/sales/sales.router');
const { productionRouter } = require('./api/production/production.router');
const { dispatchRouter } = require('./api/dispatch/dispatch.router');
const { ledgerRouter } = require('./api/ledger/ledger.router');
const { invoicingRouter } = require('./api/invoicing/invoicing.router');
const { returnsRouter } = require('./api/returns/returns.router');
const { paymentsRouter } = require('./api/payments/payments.router');
const { workforceRouter } = require('./api/workforce/workforce.router');
const { expensesRouter } = require('./api/expenses/expenses.router');
const { gstrRouter } = require('./api/gstr/gstr.router');
const { analyticsRouter } = require('./api/analytics/analytics.router');
const { reportsRouter } = require('./api/reports/reports.router');
const { notificationsRouter } = require('./api/notifications/notifications.router');
const { migrationRouter } = require('./api/migration/migration.router');
require('./models/index');

const app = express();

// Security Middlewares
app.use(helmet());
app.use(
  cors({
    origin: env.CORS_ORIGIN,
    credentials: true,
  })
);
app.use(apiLimiter);

// Parsers
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Logging
app.use(
  morgan('combined', {
    stream: { write: (message) => logger.info(message.trim()) },
  })
);

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Serve local uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

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
app.use('/api/v1/price-lists', pricingRouter);
app.use('/api/v1/inventory', inventoryRouter);
app.use('/api/v1/purchasing', purchasingRouter);
app.use('/api/v1/transfers', transferRouter);
app.use('/api/v1/sales', salesRouter);
app.use('/api/v1/production', productionRouter);
app.use('/api/v1/dispatch', dispatchRouter);
app.use('/api/v1/ledger', ledgerRouter);
app.use('/api/v1/invoices', invoicingRouter);
app.use('/api/v1/returns', returnsRouter);
app.use('/api/v1', paymentsRouter); // Mounts /receipts, /payments
app.use('/api/v1/workforce', workforceRouter);
app.use('/api/v1/expenses', expensesRouter);
app.use('/api/v1/gstr', gstrRouter);
app.use('/api/v1/analytics', analyticsRouter);
app.use('/api/v1/reports', reportsRouter);
app.use('/api/v1/notifications', notificationsRouter);
app.use('/api/v1/migration', migrationRouter);

// Unmatched routes -> JSON 404 (must come after all routes, before the error handler)
app.use(notFoundHandler);

// Global Error Handler (must be last)
app.use(errorHandler);

module.exports = { app };
