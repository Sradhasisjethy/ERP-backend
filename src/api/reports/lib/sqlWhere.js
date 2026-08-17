const { ForbiddenError } = require('../../../core/AppError');

/**
 * Bind-parameter WHERE builder for the reporting layer.
 *
 * Reports are the one place in this codebase that runs hand-written SQL rather
 * than going through Sequelize finders, because they aggregate across a dozen
 * tables with GROUP BY and window functions that the ORM expresses badly. That
 * buys performance and costs a safety net: `BaseScopedModel`'s beforeFind hook
 * only applies to model queries, so a raw report query is NOT tenant-scoped
 * automatically. Forgetting one `tenantId` predicate would leak another
 * tenant's books.
 *
 * So no report builds its own WHERE string. They all take one of these, which:
 *   - is constructed by the runner with the tenant predicate already applied
 *     (see `SqlWhere.forTenant`), and
 *   - only ever emits values as `$n` bind parameters, never interpolated text.
 *
 * Column names passed in are always literals written in this repo — they never
 * come from the request. Client-supplied identifiers (sortBy) are resolved
 * through a per-report allow-list in the runner instead.
 */
class SqlWhere {
  constructor(bind = []) {
    this.parts = [];
    this.bind = bind;
  }

  /**
   * Starts a WHERE that is already restricted to the current tenant. Every
   * report's root table is joined on this alias, so one predicate covers the
   * whole query — child tables are reached only through FKs that cannot cross
   * a tenant boundary.
   */
  static forTenant(tenantId, ...columns) {
    const where = new SqlWhere();
    for (const column of columns) where.eq(column, tenantId);
    return where;
  }

  /** Registers a value and returns its `$n` placeholder. */
  param(value) {
    this.bind.push(value);
    return `$${this.bind.length}`;
  }

  /** Adds a pre-built fragment. `sql` must be repo-authored, never user input. */
  raw(sql) {
    if (sql) this.parts.push(`(${sql})`);
    return this;
  }

  eq(column, value) {
    if (value === undefined || value === null || value === '') return this;
    this.parts.push(`${column} = ${this.param(value)}`);
    return this;
  }

  /**
   * Equality against a Postgres ENUM column, compared as text.
   *
   * `enum_col = $1` makes Postgres cast the parameter to the enum type, and a
   * value outside the vocabulary raises `invalid input value for enum ...` —
   * a 500 for what is really "the client asked for a status that doesn't
   * exist". Comparing as text turns that into an empty result set, which is
   * the honest answer to an unmatchable filter, and keeps a malformed query
   * string from looking like a server fault.
   */
  token(column, value) {
    if (value === undefined || value === null || value === '') return this;
    this.parts.push(`${column}::text = ${this.param(String(value))}`);
    return this;
  }

  ne(column, value) {
    if (value === undefined || value === null || value === '') return this;
    this.parts.push(`${column} <> ${this.param(value)}`);
    return this;
  }

  /**
   * `column = ANY($n)`. The cast is explicit because node-postgres sends a JS
   * array as an untyped literal: without `::uuid[]` Postgres compares uuid to
   * text and fails at runtime rather than at review time.
   */
  in(column, values, cast = 'uuid') {
    if (!Array.isArray(values) || !values.length) return this;
    this.parts.push(`${column} = ANY(${this.param(values)}::${cast}[])`);
    return this;
  }

  gt(column, value) {
    if (value === undefined || value === null || value === '') return this;
    this.parts.push(`${column} > ${this.param(value)}`);
    return this;
  }

  gte(column, value) {
    if (value === undefined || value === null || value === '') return this;
    this.parts.push(`${column} >= ${this.param(value)}`);
    return this;
  }

  lte(column, value) {
    if (value === undefined || value === null || value === '') return this;
    this.parts.push(`${column} <= ${this.param(value)}`);
    return this;
  }

  /**
   * Inclusive business-date range.
   *
   * Business dates in this schema are DATEONLY, so `<= dateTo` really does
   * include everything on dateTo. Audit-style columns (StockLedgerEntry.createdAt,
   * JournalEntry.createdAt) are full timestamps, where `<= '2026-08-14'` silently
   * means "up to 2026-08-14 00:00:00" and drops the whole working day. Pass
   * `{ timestamp: true }` for those and the upper bound becomes an exclusive
   * next-midnight instead.
   */
  dateRange(column, from, to, { timestamp = false } = {}) {
    if (from) this.parts.push(`${column} >= ${this.param(from)}${timestamp ? '::timestamptz' : '::date'}`);
    if (to) {
      this.parts.push(
        timestamp
          ? `${column} < (${this.param(to)}::date + INTERVAL '1 day')`
          : `${column} <= ${this.param(to)}::date`
      );
    }
    return this;
  }

  /**
   * Case-insensitive OR-match across an explicit column list (FR: search only
   * meaningful fields, never every column). `%` and `_` in the user's term are
   * escaped so a search for "50%" doesn't turn into a full-table wildcard scan.
   */
  search(columns, term) {
    const value = String(term ?? '').trim();
    if (!value || !columns.length) return this;
    const placeholder = this.param(`%${value.replace(/[\\%_]/g, '\\$&')}%`);
    this.parts.push(columns.map((column) => `${column} ILIKE ${placeholder}`).join(' OR '));
    return this;
  }

  /**
   * BR-29 location scoping, mirroring core/factoryAccess.js#applyFactoryFilter
   * for raw SQL.
   *
   * @param {string} column               qualified factory column
   * @param {string[]|null} allowedIds    null means unrestricted (platform/tenant admin)
   * @param {string} [requestedId]        an explicit ?factoryId= filter
   */
  factoryScope(column, allowedIds, requestedId) {
    const fragment = this.factoryScopeSql(column, allowedIds, requestedId);
    return fragment ? this.raw(fragment) : this;
  }

  /**
   * The same rule as `factoryScope`, returned as a fragment instead of being
   * appended — for the handful of reports that must apply location scoping
   * inside a subquery or LATERAL rather than in the top-level WHERE. Parameters
   * still land in this builder's bind array, so numbering stays correct.
   *
   * Returns `null` when the caller is unrestricted and asked for no particular
   * factory, i.e. when there is nothing to add.
   */
  factoryScopeSql(column, allowedIds, requestedId) {
    if (allowedIds === null) return requestedId ? `${column} = ${this.param(requestedId)}` : null;

    if (requestedId) {
      if (!allowedIds.includes(requestedId)) throw new ForbiddenError('You do not have access to this factory');
      return `${column} = ${this.param(requestedId)}`;
    }

    // An impossible UUID keeps the query well-formed (and empty) for a user with
    // no factory assigned, rather than matching every row.
    const ids = allowedIds.length ? allowedIds : ['00000000-0000-0000-0000-000000000000'];
    return `${column} = ANY(${this.param(ids)}::uuid[])`;
  }

  get sql() {
    return this.parts.length ? this.parts.map((p) => `(${p})`).join(' AND ') : 'TRUE';
  }
}

module.exports = { SqlWhere };
