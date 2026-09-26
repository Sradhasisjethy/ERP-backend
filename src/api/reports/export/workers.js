const { Worker } = require('worker_threads');
const os = require('os');
const path = require('path');
const { AppError } = require('../../../core/AppError');
const { logger } = require('../../../utils/logger');

/**
 * A small pool of threads that turn report data into XLSX and PDF bytes.
 *
 * Why a thread at all: building a file is CPU work, and Node runs one request
 * at a time on its main thread. Measured before this existed, a 10,000-row PDF
 * held that thread for fifteen seconds at 100 %, and a streamed XLSX still
 * held it for ~70 % of two seconds. During that time nobody else's request —
 * a login, a save, a search — moved. One person's export stalled everyone.
 *
 * With the build in a worker, the main thread does only what it must: run the
 * query, hand the rows over, and copy chunks to the socket as they arrive. An
 * export now slows the person downloading it, not the plant.
 *
 * Why not a queue product: the file is streamed straight back to the request
 * that asked for it, so nothing needs to survive a restart or run elsewhere.
 * `worker_threads` is built in, needs no service, and is what the scalability
 * audit (docs/scalability-audit.md §8) recommended for this stage.
 *
 * Sizing: at most `cpus - 1` workers, capped at four, so exports can never
 * take every core from the process that is serving everyone else. Beyond that
 * a short queue waits; beyond the queue the caller is told to try again
 * rather than left holding a connection.
 */

const MAX_WORKERS = Math.max(1, Math.min(4, os.cpus().length - 1));
const MAX_QUEUE = 20;
/** An idle thread is kept warm this long, then let go. */
const IDLE_MS = 60 * 1000;
const WORKER_FILE = path.join(__dirname, 'worker.js');

const idle = [];
const busy = new Set();
const waiting = [];
let nextJobId = 1;

const spawn = () => {
  const worker = new Worker(WORKER_FILE);
  // A parked worker must not keep the process alive on its own — the server's
  // listener does that; tests and scripts should be able to exit.
  worker.unref();
  return worker;
};

const retire = (worker) => {
  clearTimeout(worker.idleTimer);
  const at = idle.indexOf(worker);
  if (at >= 0) idle.splice(at, 1);
  busy.delete(worker);
  worker.terminate().catch(() => {});
};

const park = (worker) => {
  busy.delete(worker);
  const next = waiting.shift();
  if (next) {
    next(worker);
    return;
  }
  idle.push(worker);
  worker.idleTimer = setTimeout(() => retire(worker), IDLE_MS);
  worker.idleTimer.unref();
};

const acquire = () =>
  new Promise((resolve, reject) => {
    const worker = idle.pop();
    if (worker) {
      clearTimeout(worker.idleTimer);
      resolve(worker);
      return;
    }
    if (busy.size < MAX_WORKERS) {
      resolve(spawn());
      return;
    }
    if (waiting.length >= MAX_QUEUE) {
      reject(new AppError('Too many exports are running right now. Please try again in a moment.', 503));
      return;
    }
    waiting.push(resolve);
  });

/**
 * Builds `format` from `payload` on a worker and pipes the bytes to `stream`
 * (normally the HTTP response). Resolves when the last byte has been written.
 *
 * `payload` must be plain data — it crosses a thread boundary by structured
 * clone, so functions and model instances do not survive. index.js shapes it.
 */
const renderInWorker = async (format, payload, stream) => {
  const worker = await acquire();
  busy.add(worker);
  const id = nextJobId++;

  return new Promise((resolve, reject) => {
    let settled = false;
    let paused = false;

    const finish = (error) => {
      if (settled) return;
      settled = true;
      worker.off('message', onMessage);
      worker.off('error', onError);
      worker.off('exit', onExit);
      stream.off('drain', onDrain);
      stream.off('close', onClose);
      if (error) {
        // The thread may be mid-build; there is no way to ask it to stop, so
        // it is dropped and a fresh one spawns for the next export.
        retire(worker);
        reject(error);
      } else {
        park(worker);
        resolve();
      }
    };

    const onDrain = () => {
      if (!paused) return;
      paused = false;
      worker.postMessage({ resume: true });
    };

    const onMessage = (message) => {
      if (message.id !== id) return;
      if (message.chunk) {
        const ok = stream.write(Buffer.from(message.chunk.buffer, message.chunk.byteOffset, message.chunk.byteLength));
        if (!ok && !paused) {
          paused = true;
          worker.postMessage({ pause: true });
        }
        return;
      }
      if (message.done) {
        // Let the response end normally; the caller decides whether to close.
        if (typeof stream.end === 'function') stream.end();
        finish();
        return;
      }
      if (message.error) {
        const error = new Error(message.error.message);
        error.stack = message.error.stack || error.stack;
        finish(error);
      }
    };

    const onError = (error) => finish(error);
    const onExit = (code) => {
      if (!settled) finish(new Error(`Export worker exited with code ${code} before the file was finished`));
    };
    /** The client went away; stop paying for a file nobody will receive. */
    const onClose = () => {
      if (!settled) finish(new Error('Export cancelled: the connection closed before the file was finished'));
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.on('exit', onExit);
    stream.on('drain', onDrain);
    stream.on('close', onClose);

    worker.postMessage({ id, format, payload });
  }).catch((error) => {
    logger.warn(`Export in worker failed: ${error.message}`);
    throw error;
  });
};

/** For tests and a graceful shutdown: drop every thread. */
const shutdownExportWorkers = async () => {
  const all = [...idle, ...busy];
  idle.length = 0;
  busy.clear();
  waiting.length = 0;
  await Promise.all(all.map((worker) => { clearTimeout(worker.idleTimer); return worker.terminate().catch(() => {}); }));
};

const exportWorkerStats = () => ({ idle: idle.length, busy: busy.size, waiting: waiting.length, max: MAX_WORKERS });

module.exports = { renderInWorker, shutdownExportWorkers, exportWorkerStats, MAX_WORKERS, MAX_QUEUE };
