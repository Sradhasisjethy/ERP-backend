const crypto = require('crypto');
const { UniqueConstraintError, Op } = require('sequelize');
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

  // The concrete path, not the route pattern: `/orders/:id/lines` would let the
  // same key and body sent to a *different* order replay the first order's
  // response — another document's data, and an action silently skipped.
  const endpoint = `${req.method} ${req.baseUrl}${req.path}`.slice(0, 300);
  const requestHash = fingerprint(req.body);
  // The JWT carries `userId`; this read `req.user.id`, so every row stored null.
  const userId = req.user?.userId || null;

  let claim;
  try {
    claim = await IdempotencyKey.create({ key, endpoint, requestHash, userId });
  } catch (error) {
    if (!(error instanceof UniqueConstraintError)) return next(error);

    const existing = await IdempotencyKey.findOne({ where: { key } });
    if (!existing) return next(error);

    // Same key, different request. That is not a retry — answering with the
    // first response would silently swallow whatever this one meant to do.
    // A stored response is replayed only to the user who caused it: masking
    // differs by permission, so someone else's copy may show what they cannot.
    if (existing.endpoint !== endpoint || existing.requestHash !== requestHash || existing.userId !== userId) {
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

/**
 * Sorted-key JSON, so `{a,b}` and `{b,a}` — the same form submitted twice by
 * two renders that built the object in a different order — hash the same.
 */
const stableStringify = (value) => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
};

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

// Namespaced so a derived key can never collide with a client-chosen one.
const IMPLICIT_PREFIX = 'implicit:';
// The tenant is always passed explicitly here. The model's CLS hooks would
// otherwise stamp whatever tenant the async context carries — none at app
// level, and a stale one if a pooled callback leaked it.
const NO_TENANT_HOOKS = { hooks: false };
const STILL_PROCESSING ='That request is still being processed. Wait a moment before submitting again.';

/**
 * Double-submit protection for clients that send no Idempotency-Key.
 *
 * The explicit header is opt-in, and the screens that create money documents
 * never opted in — so a double-click on "Save" posted two expenses, two
 * receipts, two vouchers. Here the key is derived instead: same user, same
 * method, same URL, same body, within `windowSeconds`, is the same action.
 *
 * Outside the window it is not: two identical petty-cash expenses an hour apart
 * are real, and refusing the second would be the worse bug. An expired row is
 * removed and the claim retried, so only the unique (tenantId, key) index —
 * never a read-then-write — decides who goes first.
 *
 * `identify(req)` returns `{ userId, tenantId }` or null. The default reads
 * req.user (router-level use, after authenticate); financialDoubleSubmitGuard
 * passes one that verifies the token itself because it runs before any router.
 * Tenant is always explicit and lookups are unscoped: at app level the CLS
 * tenant hooks are not active yet.
 */
const CLIENT_PREFIX = 'client:';

const implicitIdempotency = ({
  windowSeconds = 30,
  // When true the claim is keyed on the CLIENT's Idempotency-Key (scoped to the
  // user) and requests without one pass through untouched. When false the key
  // is derived from the request itself — see financialDoubleSubmitGuard for why
  // the app uses the keyed form.
  clientKeyOnly = false,
  identify = (req) =>
    req.user?.userId && req.user?.tenantId ? { userId: req.user.userId, tenantId: req.user.tenantId } : null,
} = {}) => async (req, res, next) => {
  try {
    if (req.method !== 'POST') return next();
    const clientKey = req.get(HEADER);
    // Derived mode leaves keyed requests to `idempotency()`; keyed mode acts on
    // nothing else.
    if (clientKeyOnly ? !clientKey : clientKey) return next();
    if (clientKey && clientKey.length > 200) return next(new ConflictError('Idempotency-Key is too long'));
    // A multipart body is not parsed yet at this point, so every upload would
    // hash as `{}` and two different files would look like a double submit.
    if (req.is('multipart/form-data')) return next();

    const identity = identify(req);
    if (!identity) return next();
    const { userId, tenantId } = identity;

    const url = req.originalUrl || req.url;
    const body = stableStringify(req.body);
    const endpoint = `${req.method} ${url.split('?')[0]}`.slice(0, 300);
    const requestHash = sha256(body);
    // Per user either way: two people sending the same key (or the same body)
    // must never be handed each other's response.
    const key = clientKeyOnly
      ? `${CLIENT_PREFIX}${sha256(`${userId}\n${clientKey}`)}`
      : IMPLICIT_PREFIX + sha256(`${userId}\n${req.method}\n${url}\n${body}`);
    const windowStart = new Date(Date.now() - windowSeconds * 1000);

    let claim = null;
    for (let attempt = 0; attempt < 2 && !claim; attempt += 1) {
      try {
        claim = await IdempotencyKey.create({ tenantId, key, endpoint, requestHash, userId }, NO_TENANT_HOOKS);
      } catch (error) {
        if (!(error instanceof UniqueConstraintError)) throw error;

        const existing = await IdempotencyKey.unscoped().findOne({ where: { tenantId, key }, ...NO_TENANT_HOOKS });
        if (!existing) continue; // released between our insert and read — try again

        if (existing.createdAt < windowStart) {
          // Expired: a fresh, intentional submission. Deleted by id AND age, so
          // a racing request that already replaced it is not knocked out.
          await IdempotencyKey.unscoped().destroy({
            where: { id: existing.id, tenantId, createdAt: { [Op.lt]: windowStart } },
            ...NO_TENANT_HOOKS,
          });
          continue;
        }

        // Same key, different request: not a retry. Replaying would silently
        // swallow whatever this one meant to do.
        if (existing.endpoint !== endpoint || existing.requestHash !== requestHash) {
          return next(new ConflictError('That idempotency key was already used for a different request. Use a new key.'));
        }

        if (existing.status === 'COMPLETED') {
          res.set('Idempotent-Replayed', 'true');
          return res.status(existing.statusCode || 200).json(existing.responseBody);
        }
        return next(new ConflictError(STILL_PROCESSING));
      }
    }
    if (!claim) return next(new ConflictError(STILL_PROCESSING));

    let settled = false;
    const release = () => Promise.resolve(claim.destroy(NO_TENANT_HOOKS)).catch(() => {});
    const originalJson = res.json.bind(res);
    res.json = (payload) => {
      settled = true;
      const statusCode = res.statusCode;
      // Only a success is replayable; a failure should be retried for real.
      const persist =
        statusCode < 400
          ? claim.update({ status: 'COMPLETED', statusCode, responseBody: payload }, NO_TENANT_HOOKS)
          : claim.destroy(NO_TENANT_HOOKS);
      // Sent once the row says COMPLETED: the double-click lands milliseconds
      // after the first response and must find something to replay, not an
      // IN_PROGRESS row and a 409. A bookkeeping failure still sends.
      Promise.resolve(persist)
        .catch(() => {})
        .then(() => originalJson(payload));
      return res;
    };
    // A handler that answers without res.json (a file, a redirect, a dropped
    // connection) leaves nothing to replay; release the claim so the user is
    // not locked out for the window.
    res.on('close', () => {
      if (!settled) release();
    });

    return next();
  } catch (error) {
    return next(error);
  }
};

/**
 * POST endpoints that create a financial or stock document — where a double
 * submit is a duplicate invoice, receipt or stock movement. Full paths as
 * mounted in app.js, taken from each router's `.post(` lines.
 */
const FINANCIAL_CREATE_PATHS = [
  '/api/v1/sales/orders',
  '/api/v1/receipts',
  '/api/v1/payments',
  '/api/v1/expenses',
  '/api/v1/retail/counter-sales',
  '/api/v1/ledger/vouchers',
  '/api/v1/production/entries',
  '/api/v1/purchasing/orders',
  '/api/v1/purchasing/receipts',
  '/api/v1/purchasing/invoices',
  '/api/v1/returns/sales-returns',
  '/api/v1/returns/purchase-returns',
  '/api/v1/returns/credit-notes',
  '/api/v1/returns/debit-notes',
  '/api/v1/workforce/advances',
  // Stock moves without a money document, but a duplicate still double-counts.
  '/api/v1/production/wastage',
  '/api/v1/workforce/contractor/material-issues',
  '/api/v1/workforce/contractor/production-entries',
  '/api/v1/invoices',
  '/api/v1/dispatch/challans',
  '/api/v1/transfers',
  '/api/v1/inventory/adjustments',
  '/api/v1/cash-register/sessions',
];
const FINANCIAL_CREATE_SET = new Set(FINANCIAL_CREATE_PATHS);

// Express routes case-insensitively and ignores one trailing slash; so must this.
const normalisePath = (path) => {
  const lower = String(path || '').toLowerCase();
  return lower.length > 1 && lower.endsWith('/') ? lower.slice(0, -1) : lower;
};

/**
 * Identity from the access token, for use before any router has run
 * `authenticate`. Signature and expiry only: revocation is authenticate's job
 * and it still runs. A request this cannot identify passes through untouched —
 * authenticate rejects it moments later.
 */
const identifyFromToken = (req) => {
  const jwt = require('jsonwebtoken');
  const { env } = require('../config/env');
  const authHeader = req.headers.authorization;
  const bearer = authHeader && authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  const token = req.cookies?.accessToken || bearer;
  if (!token) return null;
  try {
    const decoded = jwt.verify(token, env.JWT_SECRET, { algorithms: ['HS256'] });
    return decoded?.userId && decoded?.tenantId ? { userId: decoded.userId, tenantId: decoded.tenantId } : null;
  } catch {
    return null;
  }
};

// Keyed on the client's Idempotency-Key, not on the request's content. The
// first version deduplicated every identical POST it saw, and that broke real
// behaviour: concurrent identical requests that must each be judged (two
// reservations racing for the same stock), and a second identical receipt that
// must be refused for over-allocation, both got the first response replayed.
// The SPA now sends a key derived from the submitted form and a short time
// bucket (EPR-frontend src/lib/api-client.js), so a double click shares a key
// while scripts, integrations and tests that send none behave exactly as before.
const guardedImplicit = implicitIdempotency({ windowSeconds: 120, clientKeyOnly: true, identify: identifyFromToken });

/**
 * App-level guard: mount after express.json() and cookieParser(), before the
 * routers. Acts only on POST to FINANCIAL_CREATE_PATHS that carry an
 * Idempotency-Key; all else is untouched.
 */
const financialDoubleSubmitGuard = (req, res, next) => {
  if (req.method !== 'POST' || !FINANCIAL_CREATE_SET.has(normalisePath(req.path))) return next();
  return guardedImplicit(req, res, next);
};

module.exports = {
  idempotency,
  implicitIdempotency,
  financialDoubleSubmitGuard,
  FINANCIAL_CREATE_PATHS,
  stableStringify,
};
