const { app } = require('./app');
const { env } = require('./config/env');
const { sequelize } = require('./config/database');
const { logger } = require('./utils/logger');
const { startScheduler, stopScheduler } = require('./jobs/scheduler');

let httpServer;

const startServer = async () => {
  try {
    await sequelize.authenticate();
    logger.info('Database connection has been established successfully.');

    if (env.NODE_ENV === 'development') {
      try {
        await sequelize.sync();
        logger.info('Database synchronized.');
      } catch (syncError) {
        logger.warn('Sequelize sync warning (skipped alter): ' + (syncError.message || syncError));
      }
    }

    startScheduler();

    httpServer = app.listen(env.PORT, () => {
      logger.info(`Server is running on port ${env.PORT}`);
      logger.info(`Environment: ${env.NODE_ENV}`);
      logger.info(`API base: http://localhost:${env.PORT}/api/v1`);
    });
  } catch (error) {
    logger.error('Unable to connect to the database:', error);
    process.exit(1);
  }
};

const shutdown = (signal) => {
  logger.info(`${signal} received, shutting down gracefully...`);
  if (!httpServer) {
    stopScheduler();
    process.exit(0);
    return;
  }
  stopScheduler();
  httpServer.close(async () => {
    try {
      await sequelize.close();
      logger.info('HTTP server and database connection closed.');
      process.exit(0);
    } catch (error) {
      logger.error('Error during shutdown:', error);
      process.exit(1);
    }
  });
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

startServer();
