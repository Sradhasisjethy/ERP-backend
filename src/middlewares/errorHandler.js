const { sendError } = require('../utils/response');

const errorHandler = (err, req, res, next) => {
  sendError(res, err);
};

const notFoundHandler = (req, res) => {
  res.status(404).json({
    success: false,
    message: `Route ${req.method} ${req.originalUrl} not found`,
  });
};

module.exports = { errorHandler, notFoundHandler };
