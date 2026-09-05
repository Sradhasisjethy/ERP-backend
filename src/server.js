const fs = require('fs/promises');
const path = require('path');
const { app } = require('./app');
const { env } = require('./config/env');
const { sequelize } = require('./config/database');
const { logger } = require('./utils/logger');
const { startScheduler, stopScheduler } = require('./jobs/scheduler');

let httpServer;

/**
 * Warns when the database is behind the migrations on disk.
 *
 * Without sync() a missing column surfaces as a confusing query error on some
 * unrelated screen — Products failing because `isAccessory` does not exist yet,
 * for one. Naming the pending migrations at boot turns that into an obvious
 * instruction.
 *
 * It only warns. Refusing to start would be worse: a running instance mid-shift
 * is more valuable than a strict one, and the operator may be about to migrate.
 */
const assertSchemaIsMigrated = async () => {
  try {
    const files = (await fs.readdir(path.join(__dirname, 'migrations')))
      .filter((f) => f.endsWith('.js'))
      .sort();

    const [applied] = await sequelize.query('SELECT name FROM "SequelizeMeta"');
    const done = new Set(applied.map((r) => r.name));
    const pending = files.filter((f) => !done.has(f));

    if (pending.length) {
      logger.warn(
        `${pending.length} migration(s) not applied to this database — run "npx sequelize-cli db:migrate". ` +
          `Pending: ${pending.join(', ')}`
      );
    }
  } catch (error) {
    // A brand new database has no SequelizeMeta yet; that is not a failure.
    logger.warn('Could not check migration state: ' + (error.message || error));
  }
};

const startServer = async () => {
  try {
    await sequelize.authenticate();
    logger.info('Database connection has been established successfully.');

    // Deliberately no `sequelize.sync()` here.
    //
    // Booting in development used to sync the models, which creates any table
    // the models describe and the database lacks. That is how this schema
    // drifted away from the migrations in the first place: tables and columns
    // appeared because a model mentioned them, no migration was ever written,
    // and a database built purely from migrations could no longer run the app —
    // 90 columns across 11 tables by the time it was found.
    //
    // Migrations are the only thing that changes the schema now. If a boot
    // fails because a column is missing, the answer is `npx sequelize-cli
    // db:migrate`, not a sync that papers over the gap. It also removes several
    // hundred introspection queries from every restart.
    await assertSchemaIsMigrated();

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
