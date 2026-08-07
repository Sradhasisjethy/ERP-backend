const {
  ValidationError: SequelizeValidationError,
  UniqueConstraintError,
  ForeignKeyConstraintError,
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

module.exports = { sendSuccess, sendError };
