const {
  ValidationError: SequelizeValidationError,
  UniqueConstraintError,
  ForeignKeyConstraintError,
  OptimisticLockError,
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
    logger.warn({ message: error.message, fields: error.fields });
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

  logger.error({ message: error?.message || 'Unknown error', stack: error?.stack });
  return res.status(500).json({
    success: false,
    message: 'Internal Server Error',
  });
};

module.exports = { sendSuccess, sendList, sendError };
