class AppError extends Error {
  constructor(message, statusCode, isOperational = true) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = isOperational;
    Error.captureStackTrace(this, this.constructor);
  }
}

class NotFoundError extends AppError {
  constructor(message = 'Not Found') {
    super(message, 404);
  }
}

class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 401);
  }
}

class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 403);
  }
}

class ValidationError extends AppError {
  constructor(message = 'Validation Error') {
    super(message, 400);
  }
}

/**
 * Imported by auth.service.js since the forgot/reset-password flow was written,
 * but never defined here — so `throw new BadRequestError(...)` raised a
 * TypeError and surfaced as a 500 "Internal Server Error". Two paths hit it:
 * requesting a reset for a protected admin account, and submitting a reset with
 * missing fields. Both are ordinary 400s.
 */
class BadRequestError extends AppError {
  constructor(message = 'Bad request') {
    super(message, 400);
  }
}

class ConflictError extends AppError {
  constructor(message = 'Conflict') {
    super(message, 409);
  }
}

module.exports = {
  BadRequestError,
  AppError,
  NotFoundError,
  UnauthorizedError,
  ForbiddenError,
  ValidationError,
  ConflictError,
};
