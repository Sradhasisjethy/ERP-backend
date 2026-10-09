const { ZodError } = require('zod');
const { ValidationError } = require('../core/AppError');

/**
 * Validation middleware using Zod schemas.
 * @param {import('zod').AnyZodObject} schema - Zod schema to validate against
 * @param {'body'|'query'|'params'} [source] - Which part of the request to validate.
 *   If omitted, validates { body, query, params } as a combined object.
 *
 * In combined mode the parsed body replaces `req.body`. It used to be parsed and
 * thrown away, so every key the schema did not declare reached the service
 * untouched — `PUT /users/:id {"passwordHash": ...}` passed validation and was
 * written. Zod objects strip undeclared keys, so what a handler now receives is
 * exactly what its schema describes. A field a handler reads must therefore be
 * declared in its schema, or it arrives as undefined. Query and params are left
 * as they were: they are never spread into a model write, and their schemas
 * transform types (strings to numbers) that existing handlers do not expect.
 */
const validate = (schema, source) => {
  return async (req, res, next) => {
    try {
      if (source) {
        const parsed = await schema.parseAsync(req[source]);
        req[source] = parsed;
      } else {
        const parsed = await schema.parseAsync({
          body: req.body,
          query: req.query,
          params: req.params,
        });
        if (parsed && typeof parsed === 'object' && 'body' in parsed && parsed.body !== undefined) {
          req.body = parsed.body;
        }
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
