const {
  ValidationError: SequelizeValidationError,
  UniqueConstraintError,
  ForeignKeyConstraintError,
  OptimisticLockError,
  DatabaseError,
} = require('sequelize');
const { AppError } = require('../core/AppError');
const { logger } = require('./logger');

const sendSuccess = (res, data, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json({
    success: true,
    message,
    data,
  });
};

/**
 * Sends a Sequelize findAndCountAll result in the shared list envelope,
 * reading the already-coerced page/limit off `req.query` (the validate
 * middleware writes the parsed values back, see middlewares/validate.js).
 * Every list endpoint uses this so the frontend's usePaginated hook can drive
 * all of them identically.
 */
const sendList = (res, req, data, message = 'Success') => {
  const page = Number(req.query?.page) || 1;
  const limit = Number(req.query?.limit) || 10;
  const rows = Array.isArray(data) ? data : data?.rows || [];
  const count = Array.isArray(data) ? data.length : Number(data?.count ?? rows.length);

  // Some list payloads are composite — they carry a summary field alongside the
  // page of rows (e.g. the party ledger's outstandingPaise). Those extras are
  // preserved rather than dropped, so wrapping a response in the pagination
  // envelope never silently loses data the caller already computed.
  const { rows: _rows, count: _count, ...extras } = Array.isArray(data) ? {} : data || {};

  return res.status(200).json({
    success: true,
    message,
    data: { ...extras, rows, count, page, limit, totalPages: Math.max(1, Math.ceil(count / limit)) },
  });
};

const sendError = (res, error) => {
  if (error instanceof AppError) {
    if (error.statusCode >= 500 || !error.isOperational) {
      logger.error({ message: error.message, stack: error.stack, statusCode: error.statusCode });
    } else {
      logger.warn({ message: error.message, statusCode: error.statusCode });
    }
    return res.status(error.statusCode).json({
      success: false,
      message: error.message,
      // A few refusals need to be acted on rather than just shown — removing a
      // mandatory bundle component, for one, where the client offers a
      // request-approval path instead of a dead end. Only errors that set a
      // code carry this; every existing response is unchanged.
      ...(error.code ? { code: error.code } : {}),
    });
  }

  // D2: a save based on a stale read. 409 (not 500) so the client can offer
  // "reload and re-apply your change" rather than showing a crash.
  if (error instanceof OptimisticLockError) {
    logger.warn({ message: 'Optimistic lock conflict', model: error.modelName });
    return res.status(409).json({
      success: false,
      message: 'Someone else changed this record while you were editing it. Reload to see their changes, then re-apply yours.',
    });
  }

  if (error instanceof UniqueConstraintError) {
    // Field names only: for Postgres, `error.fields` maps each key column to the
    // value that collided — a duplicate employee email went into the logs whole.
    logger.warn({ message: 'Unique constraint violated', fields: Object.keys(error.fields || {}) });
    return res.status(409).json({
      success: false,
      message: 'A record with these details already exists.',
    });
  }

  if (error instanceof ForeignKeyConstraintError) {
    logger.warn({ message: error.message });
    return res.status(400).json({
      success: false,
      message: 'This operation references a record that does not exist or is still in use.',
    });
  }

  if (error instanceof SequelizeValidationError) {
    logger.warn({ message: error.message, errors: error.errors?.map((e) => e.message) });
    return res.status(400).json({
      success: false,
      message: error.errors?.map((e) => e.message).join(', ') || 'Validation error',
    });
  }

  // Postgres refusing a value's *shape* is bad input, not a server fault: a
  // non-UUID in a path, an unknown enum value, a string past its column length,
  // a number out of range, an impossible date, a NUL byte in text or JSON. These
  // all used to be 500s. The driver's message quotes the offending value, so it
  // is not logged — but the stack, route and statement (without bound values)
  // are, at warn level, so a server-side cause (a bad setting cast in SQL,
  // say) can still be told apart from a user's typo.
  const INPUT_ERROR_CODES = new Set(['22P02', '22001', '22003', '22007', '22008', '22023', '22021', '22P05']);
  if (error instanceof DatabaseError && INPUT_ERROR_CODES.has(error.original?.code)) {
    logger.warn({
      message: 'Database rejected an input value',
      code: error.original.code,
      route: res.req ? `${res.req.method} ${res.req.baseUrl || ''}${res.req.route ? res.req.route.path : res.req.path}` : undefined,
      sql: typeof error.sql === 'string' ? error.sql.slice(0, 500) : undefined,
      stack: error.stack,
    });
    return res.status(400).json({ success: false, message: 'Some of the submitted values are not valid.' });
  }

  // body-parser and friends flag client errors with `expose` and a 4xx status
  // (malformed JSON 400, too large 413, unsupported charset/encoding 415, too
  // many parameters 413, aborted 400). They were reaching the 500 below.
  if (error && error.expose && error.status >= 400 && error.status < 500) {
    logger.warn({ message: 'Request rejected', type: error.type, status: error.status });
    const messages = {
      'entity.parse.failed': 'The request body is not valid JSON.',
      'entity.too.large': 'The request is too large.',
    };
    return res.status(error.status).json({ success: false, message: messages[error.type] || 'The request could not be read.' });
  }

  // CORS refusals (app.js) are a client's origin, not a server fault.
  if (error && error.code === 'CORS_ORIGIN_REJECTED') {
    logger.warn({ message: 'CORS origin rejected', origin: error.origin });
    return res.status(403).json({ success: false, message: 'Origin not allowed' });
  }

  logger.error({ message: error?.message || 'Unknown error', stack: error?.stack });
  return res.status(500).json({
    success: false,
    message: 'Internal Server Error',
  });
};

module.exports = { sendSuccess, sendList, sendError };
