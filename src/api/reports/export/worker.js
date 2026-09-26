const { parentPort } = require('worker_threads');
const { Writable } = require('stream');
const { buildXlsx } = require('./xlsx');
const { buildPdf } = require('./pdf');

/**
 * The body of an export worker thread — see workers.js for why it exists.
 *
 * It knows nothing about the database, the request or the tenant: the main
 * thread has already run the report and hands over plain data. All this does
 * is turn that data into bytes and post them back, chunk by chunk, so the
 * response can start before the file is finished.
 *
 * Backpressure: the main thread says `pause` when the client's socket is
 * full and `resume` when it drains. Between the two, the writer here holds
 * its callback rather than producing more, so a slow download never piles a
 * whole file up in the message queue.
 */

let paused = false;
let pendingWrite = null;

const BUILDERS = { xlsx: buildXlsx, pdf: buildPdf };

const sink = (id) =>
  new Writable({
    write(chunk, encoding, callback) {
      // A private copy, so the transfer detaches only these bytes rather than
      // the 8 KB pool slab Node hands out for small writes.
      const bytes = new Uint8Array(chunk.length);
      bytes.set(chunk);
      parentPort.postMessage({ id, chunk: bytes }, [bytes.buffer]);
      if (paused) {
        pendingWrite = callback;
      } else {
        callback();
      }
    },
  });

parentPort.on('message', async (message) => {
  if (message.pause) {
    paused = true;
    return;
  }
  if (message.resume) {
    paused = false;
    if (pendingWrite) {
      const next = pendingWrite;
      pendingWrite = null;
      next();
    }
    return;
  }

  const { id, format, payload } = message;
  const build = BUILDERS[format];
  try {
    if (!build) throw new Error(`No export builder for "${format}"`);
    await build(payload, sink(id));
    parentPort.postMessage({ id, done: true });
  } catch (error) {
    parentPort.postMessage({ id, error: { message: error.message, stack: error.stack } });
  }
});
