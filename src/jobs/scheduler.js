const { runNightly } = require('./nightly');
const { logger } = require('../utils/logger');

/**
 * A minimal in-process scheduler.
 *
 * Deliberately not a cron dependency: the only recurring work in this system is
 * one nightly batch, and a timer that checks the clock every minute expresses
 * that without adding a package. If the schedule ever grows past this, move to
 * a real job runner with persistence — an in-process timer dies with the
 * process and does not coordinate across replicas.
 */

const DEFAULT_HOUR = 2; // 02:00 IST, per the workflow spec's nightly job
const CHECK_INTERVAL_MS = 60 * 1000;

let timer = null;
let lastRunDate = null;
let running = false;

const istNow = () => {
  // The server may run in UTC; the business day is IST (NFR-18).
  const now = new Date();
  return new Date(now.getTime() + (5 * 60 + 30) * 60 * 1000);
};

const tick = async ({ hour }) => {
  const ist = istNow();
  const today = ist.toISOString().slice(0, 10);

  if (ist.getUTCHours() !== hour) return;
  if (lastRunDate === today) return; // already ran today
  if (running) return; // a long run must not overlap itself

  running = true;
  lastRunDate = today;
  const startedAt = Date.now();
  try {
    logger.info({ message: 'Nightly jobs starting', date: today });
    const report = await runNightly();
    logger.info({ message: 'Nightly jobs finished', date: today, durationMs: Date.now() - startedAt, report });
  } catch (error) {
    // runNightly already isolates per-job failures; reaching here means
    // something outside the jobs themselves broke.
    logger.error({ message: 'Nightly job runner failed', error: error.message, stack: error.stack });
  } finally {
    running = false;
  }
};

const startScheduler = ({ hour = DEFAULT_HOUR } = {}) => {
  if (timer) return timer;
  timer = setInterval(() => { tick({ hour }); }, CHECK_INTERVAL_MS);
  // Don't hold the event loop open on shutdown.
  if (typeof timer.unref === 'function') timer.unref();
  logger.info({ message: `Nightly job scheduler started (runs at ${String(hour).padStart(2, '0')}:00 IST)` });
  return timer;
};

const stopScheduler = () => {
  if (timer) clearInterval(timer);
  timer = null;
};

module.exports = { startScheduler, stopScheduler, DEFAULT_HOUR };
