require('dotenv').config();
const { runNightly } = require('../jobs/nightly');
const { sequelize } = require('../config/database');
const { logger } = require('../utils/logger');

/**
 * Runs the nightly batch on demand.
 *
 * The scheduler fires at 02:00 IST, which makes curing promotion, stock ageing
 * classification and every alert effectively untestable during a working day —
 * the Analytics and Notifications screens simply stay empty. This gives QA and
 * developers the same run without waiting for the clock or restarting anything.
 *
 *   npm run jobs:run
 */
(async () => {
  try {
    const report = await runNightly();
    console.log(JSON.stringify(report, null, 2));
    await sequelize.close();
    process.exit(0);
  } catch (error) {
    logger.error({ message: 'On-demand job run failed', error: error.message, stack: error.stack });
    await sequelize.close().catch(() => {});
    process.exit(1);
  }
})();
