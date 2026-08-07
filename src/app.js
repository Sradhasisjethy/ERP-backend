const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const morgan = require('morgan');
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

// API Routes — v1
app.use('/api/v1/auth', authRouter);
app.use('/api/v1/users', userRouter);
app.use('/api/v1', organizationRouter); // Mounts /organizations, /offices, /departments
app.use('/api/v1/roles', roleRouter);
app.use('/api/v1/settings', settingsRouter);
app.use('/api/v1/dashboard', dashboardRouter);

// Unmatched routes -> JSON 404 (must come after all routes, before the error handler)
app.use(notFoundHandler);

// Global Error Handler (must be last)
app.use(errorHandler);

module.exports = { app };
