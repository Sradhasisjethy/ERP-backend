const { z } = require('zod');
const { Op } = require('sequelize');

const DEFAULT_PAGE_SIZE = 10;
const MAX_PAGE_SIZE = 200;

/**
 * Every list endpoint speaks the same query contract, so the frontend can drive
 * all of them through one hook (see front/src/hooks/use-paginated.js) instead of
 * each page reinventing page/limit/search handling.
 *
 * @param {object} extra - module-specific filters merged into the schema
 */
const listQuery = (extra = {}) =>
  z.object({
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(MAX_PAGE_SIZE).default(DEFAULT_PAGE_SIZE),
    search: z.string().trim().min(1).optional(),
    sortBy: z.string().trim().min(1).optional(),
    sortDir: z.enum(['asc', 'desc', 'ASC', 'DESC']).optional(),
    ...extra,
  });

/** Turns validated query params into Sequelize `limit`/`offset`. */
const toOffset = (page, limit) => ({ limit: Number(limit), offset: (Number(page) - 1) * Number(limit) });

/**
 * Builds a case-insensitive OR-match across the given columns. Returns
 * undefined when there's nothing to search, so it can be spread into a
 * `where` clause unconditionally.
 */
const searchWhere = (search, columns = []) => {
  if (!search || !columns.length) return undefined;
  return { [Op.or]: columns.map((col) => ({ [col]: { [Op.iLike]: `%${search}%` } })) };
};

/**
 * Resolves a client-supplied sort into a Sequelize `order`, rejecting any
 * column not explicitly allow-listed — `sortBy` comes straight from the query
 * string, so it must never reach SQL unvalidated.
 */
const toOrder = (sortBy, sortDir, allowed = [], fallback = [['createdAt', 'DESC']]) => {
  if (!sortBy || !allowed.includes(sortBy)) return fallback;
  return [[sortBy, String(sortDir || 'asc').toUpperCase() === 'DESC' ? 'DESC' : 'ASC']];
};

/** Wraps a Sequelize findAndCountAll result in the shared response envelope. */
const paginated = ({ rows, count }, page, limit) => ({
  rows,
  count,
  page: Number(page),
  limit: Number(limit),
  totalPages: Math.max(1, Math.ceil(count / Number(limit))),
});

module.exports = { listQuery, toOffset, searchWhere, toOrder, paginated, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE };
