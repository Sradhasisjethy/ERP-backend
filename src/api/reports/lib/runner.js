const { QueryTypes } = require('sequelize');
const { sequelize } = require('../../../config/database');
const { getTenantId } = require('../../../core/tenantContext');
const { getAllowedFactoryIds } = require('../../../core/factoryAccess');
const { ValidationError } = require('../../../core/AppError');
const { SqlWhere } = require('./sqlWhere');
const { visibleColumns, visibleMetrics, NUMERIC_TYPES } = require('./columns');
const { env } = require('../../../config/env');

/**
 * The one place a report is executed.
 *
 * Screen, Excel and PDF all call `executeReport`. The difference between them
 * is the page size, nothing else — same definition, same filters, same WHERE,
 * same permission stripping. That is what makes "the export must not just dump
 * the 25 visible rows" and "the export must respect the same permissions"
 * structural properties rather than things three code paths have to remember.
 */

/** Screen paging. */
const DEFAULT_PAGE_SIZE = 25;
const MAX_PAGE_SIZE = 200;

/**
 * Synchronous-export ceiling.
 *
 * This process has no durable job queue (jobs/scheduler.js is a single
 * in-process timer that dies with the process and does not coordinate across
 * replicas), so a genuinely asynchronous export would need infrastructure that
 * does not exist yet. Rather than pretend, exports run inline up to this many
 * rows and are refused above it with an actionable message. At 50k rows a
 * worst-case sheet is ~15MB and a few seconds of CPU, which one Express worker
 * can absorb; beyond that it would start blocking other requests.
 */
const MAX_EXPORT_ROWS = Number(env.REPORT_EXPORT_MAX_ROWS || 50000);

/** node-postgres returns BIGINT and NUMERIC as strings to avoid precision loss. */
const coerceValue = (value, type) => {
  if (value === null || value === undefined) return null;
  if (NUMERIC_TYPES.has(type)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return value;
};

const coerceRow = (row, typeByKey) => {
  const out = {};
  for (const [key, value] of Object.entries(row)) out[key] = coerceValue(value, typeByKey.get(key));
  return out;
};

/**
 * Resolves the client's `sortBy` against the report's allow-list. Anything not
 * on the list falls back to the report's default — a client can never name a
 * column to sort by, only pick one the report already published.
 */
const buildOrderBy = (spec, definition, { sortBy, sortDir }) => {
  const sortMap = spec.sortMap || {};
  const requested = sortBy && Object.hasOwn(sortMap, sortBy) ? sortBy : null;
  const fallback = definition.defaultSort || {};
  const key = requested || (Object.hasOwn(sortMap, fallback.by) ? fallback.by : null);
  const direction = String((requested ? sortDir : null) || fallback.dir || 'desc').toUpperCase() === 'ASC' ? 'ASC' : 'DESC';

  const clauses = [];
  if (key) clauses.push(`${sortMap[key]} ${direction} NULLS LAST`);
  // A deterministic tiebreaker keeps pagination stable: without one, two rows
  // with the same invoice date can swap places between page 1 and page 2 and a
  // row is silently seen twice or never.
  if (spec.tieBreak) clauses.push(`${spec.tieBreak} DESC`);

  return {
    sql: clauses.length ? `ORDER BY ${clauses.join(', ')}` : '',
    applied: key ? { by: key, dir: direction.toLowerCase() } : null,
  };
};

/**
 * Builds the request context a report definition's `build()` receives. Tenant
 * and factory scoping are resolved here, once, so no definition can forget them.
 */
const buildContext = async (req, params, { mode }) => {
  const tenantId = getTenantId();
  if (!tenantId) throw new ValidationError('Tenant context is missing');

  return {
    mode,
    user: req.user,
    tenantId,
    allowedFactoryIds: await getAllowedFactoryIds(req),
    params,
    /** Opens a WHERE already restricted to this tenant on the given columns. */
    where: (...tenantColumns) => SqlWhere.forTenant(tenantId, ...tenantColumns),
  };
};

const runSql = (sql, bind) => sequelize.query(sql, { bind, type: QueryTypes.SELECT });

/**
 * Executes a report and returns the page, the count and the summary.
 *
 * The summary is deliberately computed by its own aggregate over the *whole*
 * filtered set, not by adding up the page — a "Total Sales" tile that only
 * totals the 25 rows on screen is worse than no tile at all.
 *
 * One rule binds every definition: a bind parameter must be introduced in
 * `spec.from` or `spec.where`, never in `spec.select`. The count query is
 * `SELECT 1 FROM ... WHERE ...` and drops the select list entirely; Postgres
 * rejects a Bind message that supplies more parameters than the statement
 * references, so a `$n` that only appears in the select list makes the count
 * query fail at runtime. Correlated work that a row needs therefore goes in a
 * LATERAL join (part of FROM), not in a select-list subquery.
 */
const executeReport = async (definition, req, params, { mode = 'page' } = {}) => {
  const context = await buildContext(req, params, { mode });

  const columns = visibleColumns(definition.columns, { user: req.user });
  const metrics = visibleMetrics(definition.summary, { user: req.user });
  const allowedKeys = new Set(columns.map((c) => c.key));
  const deniedColumnKeys = definition.columns.filter((c) => !allowedKeys.has(c.key)).map((c) => c.key);
  const deniedMetricKeys = (definition.summary || []).filter((m) => !metrics.some((v) => v.key === m.key)).map((m) => m.key);

  // A non-tabular report (KPI dashboard) computes itself; it still goes through
  // the same permission stripping below.
  if (definition.kind === 'kpi') {
    const summary = await definition.compute(context);
    for (const key of deniedMetricKeys) delete summary[key];
    return { columns: [], rows: [], count: 0, page: 1, limit: 0, totalPages: 1, summary, metrics, sort: null };
  }

  const spec = await definition.build(context);
  const where = spec.where.sql;
  const bind = spec.where.bind;
  const groupBy = spec.groupBy ? `GROUP BY ${spec.groupBy}` : '';
  const having = spec.having ? `HAVING ${spec.having}` : '';
  const from = `FROM ${spec.from} WHERE ${where} ${groupBy} ${having}`;

  const isExport = mode === 'export';
  const page = isExport ? 1 : Math.max(1, Number(params.page) || 1);
  const limit = isExport ? MAX_EXPORT_ROWS : Math.min(MAX_PAGE_SIZE, Math.max(1, Number(params.limit) || DEFAULT_PAGE_SIZE));
  const offset = (page - 1) * limit;

  const [countRow] = await runSql(`SELECT COUNT(*)::bigint AS count FROM (SELECT 1 ${from}) _c`, bind);
  const count = Number(countRow?.count || 0);

  if (isExport && count > MAX_EXPORT_ROWS) {
    throw new ValidationError(
      `This export would contain ${count.toLocaleString('en-IN')} rows, over the ${MAX_EXPORT_ROWS.toLocaleString('en-IN')}-row limit. ` +
        'Narrow the date range or add a filter, then try again.'
    );
  }

  const order = buildOrderBy(spec, definition, params);
  const dataBind = [...bind, limit, offset];
  const rows = await runSql(
    `SELECT ${spec.select} ${from} ${order.sql} LIMIT $${dataBind.length - 1} OFFSET $${dataBind.length}`,
    dataBind
  );

  const typeByKey = new Map(definition.columns.map((c) => [c.key, c.type]));
  const mapped = rows.map((row) => {
    const coerced = coerceRow(row, typeByKey);
    for (const key of deniedColumnKeys) delete coerced[key];
    return spec.mapRow ? spec.mapRow(coerced) : coerced;
  });

  let summary = {};
  if (spec.summarySelect) {
    // Same FROM and same WHERE as the page — the tiles and the table can never
    // describe different result sets.
    const summaryFrom = spec.summaryFrom || spec.from;
    const summarySql = spec.summaryGroupBy
      ? `SELECT ${spec.summarySelect} FROM (SELECT ${spec.select} FROM ${summaryFrom} WHERE ${where} ${groupBy} ${having}) _s`
      : `SELECT ${spec.summarySelect} FROM ${summaryFrom} WHERE ${where}`;
    const [summaryRow] = await runSql(summarySql, bind);
    const metricTypes = new Map((definition.summary || []).map((m) => [m.key, m.type]));
    summary = coerceRow(summaryRow || {}, metricTypes);
    for (const key of deniedMetricKeys) delete summary[key];
  }

  return {
    columns,
    metrics,
    rows: mapped,
    count,
    page,
    limit,
    totalPages: Math.max(1, Math.ceil(count / limit)),
    summary,
    sort: order.applied,
  };
};

module.exports = { executeReport, buildContext, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, MAX_EXPORT_ROWS };
