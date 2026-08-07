const { ZodError } = require('zod');
const { ValidationError } = require('../core/AppError');

/**
 * Validation middleware using Zod schemas.
 * @param {import('zod').AnyZodObject} schema - Zod schema to validate against
 * @param {'body'|'query'|'params'} [source] - Which part of the request to validate.
 *   If omitted, validates { body, query, params } as a combined object.
 */
const validate = (schema, source) => {
  return async (req, res, next) => {
    try {
      if (source) {
        const parsed = await schema.parseAsync(req[source]);
        req[source] = parsed;
      } else {
        await schema.parseAsync({
          body: req.body,
          query: req.query,
          params: req.params,
        });
      }
      next();
    } catch (error) {
      if (error instanceof ZodError) {
        return next(new ValidationError(error.errors.map((e) => e.message).join(', ')));
      }
      next(error);
    }
  };
};

module.exports = { validate };
