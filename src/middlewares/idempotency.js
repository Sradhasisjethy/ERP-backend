const crypto = require('crypto');
const { UniqueConstraintError } = require('sequelize');
const { IdempotencyKey } = require('../api/idempotency/idempotencyKey.model');
const { ConflictError, ValidationError } = require('../core/AppError');

const HEADER = 'idempotency-key';

const fingerprint = (body) => crypto.createHash('sha256').update(JSON.stringify(body ?? null)).digest('hex');

/**
 * Makes a mutating endpoint safe to retry.
 *
 * The client sends `Idempotency-Key` once per intended action; a retry carries
 * the same one and gets the first response back rather than performing the
 * action again. Without it, a salesperson on a bad connection tapping "add"
 * twice puts two printers and two sets of accessories on the order.
 *
 * A row is claimed *before* the handler runs, so the unique (tenantId, key)
 * index — not application logic — is what stops two concurrent retries from
 * both going through.
 *
 * The key is optional by default: existing clients keep working, and the ones
 * that care about retries opt in. Pass `{ required: true }` for an endpoint
 * where a duplicate would be expensive enough to refuse the request without it.
 */
const idempotency = ({ required = false } = {}) => async (req, res, next) => {
  const key = req.get(HEADER);

  if (!key) {
    if (required) return next(new ValidationError('This request needs an Idempotency-Key header'));
    return next();
  }

  const endpoint = `${req.method} ${req.baseUrl}${req.route ? req.route.path : req.path}`;
  const requestHash = fingerprint(req.body);

  let claim;
  try {
    claim = await IdempotencyKey.create({ key, endpoint, requestHash, userId: req.user?.id || null });
  } catch (error) {
    if (!(error instanceof UniqueConstraintError)) return next(error);

    const existing = await IdempotencyKey.findOne({ where: { key } });
    if (!existing) return next(error);

    // Same key, different request. That is not a retry — answering with the
    // first response would silently swallow whatever this one meant to do.
    if (existing.endpoint !== endpoint || existing.requestHash !== requestHash) {
      return next(
        new ConflictError('That idempotency key was already used for a different request. Use a new key.')
      );
    }

    if (existing.status === 'COMPLETED') {
      return res.status(existing.statusCode || 200).json(existing.responseBody);
    }

    // The first attempt is still running. Telling the client to wait is honest;
    // proceeding would produce exactly the duplicate this exists to prevent.
    return next(
      new ConflictError('That request is still being processed. Retry in a moment with the same key.')
    );
  }

  // Record what the handler answered, so the next retry can be given the same.
  const originalJson = res.json.bind(res);
  res.json = (body) => {
    const statusCode = res.statusCode;
    // Only successful responses are replayable: a failure should be retried for
    // real, not have its error handed back forever.
    const persist =
      statusCode < 400
        ? claim.update({ status: 'COMPLETED', statusCode, responseBody: body })
        : claim.destroy();

    // Fire-and-forget: a bookkeeping failure must not turn a completed action
    // into an error the client will retry.
    Promise.resolve(persist).catch(() => {});
    return originalJson(body);
  };

  next();
};

module.exports = { idempotency };
