const { Op } = require('sequelize');
const { sequelize } = require('../../config/database');
const { MasterImportRun } = require('./importRun.model');
const { getConfig, importColumns, visibleColumns, describe, permissionsFor, CONFIGS } = require('./registry');
const { loadLookups } = require('./lookups');
const { coerce } = require('./columns');
const { buildTemplate, buildExport, buildErrorWorkbook, readWorkbook } = require('./excel');
const { ValidationError, ConflictError, NotFoundError, ForbiddenError } = require('../../core/AppError');
const { todayLocal } = require('../../utils/businessDate');
const { logger } = require('../../utils/logger');

/**
 * The import/export engine.
 *
 * Four things are worth knowing before reading it:
 *
 *  1. **It never writes a table.** Every create and update goes through the
 *     same service the New/Edit dialog calls, so an import cannot skip a rule
 *     the screen enforces — nor drift away from one that changes later. The
 *     audit trail comes along free, because those services write through models
 *     that audit themselves.
 *
 *  2. **Validate and commit are separate calls, and the rows live here.** The
 *     commit names a run id; it does not resend rows. If it did, validating a
 *     clean file and committing a different one would be trivial and the whole
 *     preview would be theatre.
 *
 *  3. **All or nothing.** One bad row stops the file. Master data is what every
 *     document refers to, and a half-loaded product list is worse than none —
 *     it is the version everyone starts working against.
 *
 *  4. **Matching is ID first, then business key.** An exported file carries the
 *     record id, so a round trip updates exactly the rows it came from even
 *     where a code was edited. A hand-built file has no ids and matches on the
 *     code alone, which is why every importable master has one.
 */

const IMPORT_MODES = ['UPSERT', 'CREATE', 'UPDATE'];
const PREVIEW_ROW_LIMIT = 500;
const RUN_RETENTION_DAYS = 7;

const normalizeKey = (value) => String(value ?? '').trim().toUpperCase();

/** Values that go to the business service: not the ID, not export-only columns. */
const applicableColumns = (config) => config.columns.filter((column) => !column.readOnly && !column.exportOnly);

const rateHeaders = (config) => config.columns.filter((column) => column.rate).map((column) => column.header);

/** Has this column already got the value the file is asking for? */
const sameValue = (column, current, next) => {
  if (next === undefined) return true;
  if (current === null || current === undefined) return next === null || next === undefined;
  switch (column.type) {
    case 'money':
    case 'number':
    case 'integer':
      return Number(current) === Number(next);
    case 'boolean':
      return Boolean(current) === Boolean(next);
    case 'date':
      return String(current).slice(0, 10) === String(next).slice(0, 10);
    default:
      return String(current) === String(next);
  }
};

class MasterDataService {
  static modules() {
    return CONFIGS.map(describe);
  }

  /** Resolves the extra thing a module needs, e.g. which price list the rates belong to. */
  static async resolveContext(config, query = {}) {
    if (!config.context) return {};
    const value = query[config.context.param];
    if (!value) throw new ValidationError(`Choose a ${config.context.label} first.`);
    const resolved = await config.context.resolve(value);
    return { [config.context.param]: value, resolved };
  }

  static assertCanSeeRates(config, canViewRates) {
    if (config.ratesRequired && !canViewRates) {
      throw new ForbiddenError(`${config.label} is entirely rate data — your role does not permit viewing rates (BR-27).`);
    }
  }

  /**
   * Holding the import grant is not a licence to create records you could not
   * create by hand. A role allowed to correct existing products but not to add
   * new ones keeps exactly that boundary when it uploads a file.
   *
   * `can` is the caller permission test; when it is not supplied (a script, a
   * test calling the service directly) there is no request user to check.
   */
  static assertCanWrite(config, { newRows, updateRows }, can) {
    if (!can) return;
    const permissions = permissionsFor(config);
    if (newRows > 0 && !can(permissions.create)) {
      throw new ForbiddenError(`This file would create ${newRows} new record${newRows === 1 ? '' : 's'}, and your role may not create ${config.label}.`);
    }
    if (updateRows > 0 && !can(permissions.update)) {
      throw new ForbiddenError(`This file would change ${updateRows} existing record${updateRows === 1 ? '' : 's'}, and your role may not edit ${config.label}.`);
    }
  }

  // --- Template ------------------------------------------------------------

  static async template(moduleKey, { canViewRates }) {
    const config = getConfig(moduleKey);
    this.assertCanSeeRates(config, canViewRates);
    const columns = visibleColumns(config, { canViewRates }).filter((column) => !column.exportOnly);

    const buffer = await buildTemplate({
      label: config.label,
      columns,
      examples: config.examples,
      mode: `A row is matched to an existing record by its ID if there is one, otherwise by ${config.businessKeyHeader}. A ${config.businessKeyHeader} that is not already in use creates a new record.`,
      dependsOn: config.dependsOn,
      notes: config.notes,
    });

    return { buffer, fileName: `${config.fileBase}_Sample.xlsx` };
  }

  // --- Export --------------------------------------------------------------

  static async exportRecords(moduleKey, { query = {}, canViewRates, meta = {} }) {
    const config = getConfig(moduleKey);
    this.assertCanSeeRates(config, canViewRates);
    const context = await this.resolveContext(config, query);
    const columns = visibleColumns(config, { canViewRates });

    const records = (await config.load({ query, context })).map((record) =>
      typeof record.toJSON === 'function' ? record.toJSON() : record
    );

    const buffer = await buildExport({
      label: config.label,
      columns,
      records,
      meta: {
        ...meta,
        mode: `Edit the rows you want to change and upload this file again. Rows are matched by ID, so ${config.businessKeyHeader} may be corrected. Delete the rows you do not want to touch.`,
        dependsOn: config.dependsOn,
        notes: config.notes,
      },
    });

    const suffix = context.resolved?.name ? `_${String(context.resolved.name).replace(/[^A-Za-z0-9]+/g, '_')}` : '';
    return { buffer, fileName: `${config.fileBase}${suffix}_${todayLocal()}.xlsx`, count: records.length };
  }

  /**
   * How long the commit will take, measured rather than guessed.
   *
   * The commit writes every row through the module own service — the same one
   * the New/Edit dialog calls — so each row costs one round trip to re-check
   * its business key, one per reference it names, one to write the record and
   * one to write its audit row. That is the price of not bypassing the rules,
   * and against a database on another host it is round trips, not work, that
   * the clock measures: 1,000 products across a 29 ms link is about two
   * minutes, and the same import against a database in the same data centre is
   * a few seconds.
   *
   * So the estimate is the measured round-trip time multiplied by the writes
   * the file will make. It is shown before the user commits, because a
   * two-minute wait nobody was warned about reads as a hang.
   */
  static async estimateCommit(config, rows) {
    const writing = rows.filter((row) => row.status === 'NEW' || row.status === 'UPDATE');
    if (!writing.length) return { estimatedCommitSeconds: 0, databaseRoundTripMs: 0 };

    const started = Date.now();
    for (let probe = 0; probe < 3; probe += 1) {
      // eslint-disable-next-line no-await-in-loop -- measuring latency, so they must be sequential
      await sequelize.query('SELECT 1', { logging: false });
    }
    const roundTripMs = (Date.now() - started) / 3;

    // What this module actually cost last time beats any formula: it already
    // accounts for how many round trips that particular service makes, which
    // varies per master and changes whenever one of them does.
    const previous = await MasterImportRun.findOne({
      where: { module: config.key, status: 'COMMITTED' },
      attributes: ['durationMs', 'createdCount', 'updatedCount'],
      order: [['createdAt', 'DESC']],
    });
    const previousWrites = previous ? previous.createdCount + previous.updatedCount : 0;

    // A create costs an insert and its audit row; an update costs a fetch as
    // well. Used until this module has been imported once.
    const perWrite = previousWrites >= 20 && previous.durationMs
      ? previous.durationMs / previousWrites
      : roundTripMs * (config.commitAll ? 1 : 3);

    return {
      estimatedCommitSeconds: Math.max(1, Math.round((writing.length * perWrite) / 1000)),
      databaseRoundTripMs: Math.round(roundTripMs),
    };
  }

  // --- Validate ------------------------------------------------------------

  /**
   * Reads the file, checks every row, and writes a run that a commit can name.
   * Nothing is written to any master here — the run row is the only insert.
   */
  static async validate(moduleKey, { buffer, fileName, importMode = 'UPSERT', query = {}, canViewRates, userId, can }) {
    const startedAt = Date.now();
    const config = getConfig(moduleKey);
    this.assertCanSeeRates(config, canViewRates);
    if (!IMPORT_MODES.includes(importMode)) throw new ValidationError(`Unknown import mode "${importMode}"`);

    const context = await this.resolveContext(config, query);
    const readColumns = importColumns(config);
    const skippedRateHeaders = canViewRates ? [] : rateHeaders(config);

    const { rows: fileRows } = await readWorkbook(buffer, readColumns, {
      optionalHeaders: skippedRateHeaders,
      ignoreHeaders: config.columns.filter((column) => column.exportOnly).map((column) => column.header),
    });

    const lookups = await loadLookups(readColumns);
    const existing = await this.loadExisting(config, context);

    const warnings = [];
    if (skippedRateHeaders.length) {
      warnings.push(
        `Rate columns (${skippedRateHeaders.join(', ')}) are ignored — your role does not permit viewing or setting rates. Everything else in the file is imported.`
      );
    }

    const seenKeys = new Map();
    const seenIds = new Map();
    const rows = [];

    for (const fileRow of fileRows) {
      const row = this.checkRow({ config, fileRow, readColumns, lookups, canViewRates });

      // Two rows claiming the same record would have the second silently
      // overwrite the first, and the user would never know which one won.
      if (!row.errors.length) {
        const duplicateOf = (row.id && seenIds.get(row.id)) || (row.key && seenKeys.get(row.key));
        if (duplicateOf) {
          row.errors.push({
            message: `Repeats ${config.businessKeyHeader} "${row.raw[config.businessKeyHeader] ?? row.key}" from row ${duplicateOf}`,
          });
        } else {
          if (row.id) seenIds.set(row.id, fileRow.rowNumber);
          if (row.key) seenKeys.set(row.key, fileRow.rowNumber);
        }
      }

      if (!row.errors.length) this.decideAction({ config, row, existing, importMode });
      if (row.errors.length) row.status = 'ERROR';
      rows.push(row);
    }

    const counts = this.count(rows);
    this.assertCanWrite(config, counts, can);

    const run = await MasterImportRun.create({
      module: config.key,
      fileName: String(fileName || 'upload.xlsx').slice(0, 255),
      importMode,
      status: counts.errorRows ? 'FAILED' : 'VALIDATED',
      ...counts,
      payload: { rows },
      context: config.context ? { [config.context.param]: context[config.context.param] } : null,
      warnings: warnings.length ? warnings : null,
      durationMs: Date.now() - startedAt,
      userId: userId || null,
    });

    await this.prune();

    logger.info({
      message: '[IMPORT] validated',
      module: config.key,
      importId: run.id,
      file: run.fileName,
      rows: counts.totalRows,
      errors: counts.errorRows,
      durationMs: run.durationMs,
    });

    const estimate = await this.estimateCommit(config, rows);
    return this.preview(run, { config, context, warnings, estimate });
  }

  /** Every existing record, keyed by id and by business key. */
  static async loadExisting(config, context) {
    const records = (await config.load({ query: {}, context })).map((record) =>
      typeof record.toJSON === 'function' ? record.toJSON() : record
    );
    const byId = new Map();
    const byKey = new Map();
    for (const record of records) {
      byId.set(String(record.id), record);
      const key = config.keyOf ? config.keyOf(record) : normalizeKey(record[config.businessKey]);
      if (key && !byKey.has(key)) byKey.set(key, record);
    }
    return { byId, byKey };
  }

  /** Cell-by-cell checks: type, length, range, allowed values, references. */
  static checkRow({ config, fileRow, readColumns, lookups, canViewRates }) {
    const values = {};
    const errors = [];

    for (const column of readColumns) {
      if (column.rate && !canViewRates) continue;
      const { value, error } = coerce(column, fileRow.raw[column.header], lookups);
      if (error) errors.push({ column: column.header, message: error });
      else if (value !== undefined && !column.readOnly) values[column.field] = value;
      else if (value !== undefined && column.readOnly) values[`__${column.field}`] = value;
    }

    const id = values.__id ? String(values.__id).trim() : null;
    delete values.__id;

    const key = config.keyFromValues
      ? config.keyFromValues(values)
      : normalizeKey(values[config.businessKey]);

    if (!id && !key && !errors.length) {
      errors.push({ column: config.businessKeyHeader, message: `${config.businessKeyHeader} is required to match or create a record` });
    }

    return { rowNumber: fileRow.rowNumber, raw: fileRow.raw, values, id, key, errors, status: 'NEW' };
  }

  /** New, update, unchanged or skipped — and whether the chosen mode allows it. */
  static decideAction({ config, row, existing, importMode }) {
    const record = (row.id && existing.byId.get(row.id)) || (row.key && existing.byKey.get(row.key)) || null;

    if (row.id && !record) {
      row.errors.push({ column: 'ID', message: 'No record with this ID exists any more — clear the ID column to create a new record' });
      return;
    }

    if (config.skipRow) {
      const reason = config.skipRow(row.values, record);
      if (reason) {
        row.status = 'SKIP';
        row.note = reason;
        return;
      }
    }

    if (!record) {
      if (importMode === 'UPDATE') {
        row.errors.push({ column: config.businessKeyHeader, message: `No existing record matches — this file is running in "Update existing only" mode` });
        return;
      }
      row.status = 'NEW';
      return;
    }

    if (importMode === 'CREATE') {
      row.errors.push({ column: config.businessKeyHeader, message: `Already exists — this file is running in "Create new only" mode` });
      return;
    }

    // Matched by ID, but the file gives it a business key another record
    // already holds. Nothing above catches this — the ID matched, so the key
    // was never looked up — and it is the one way an import could make two
    // records share a code.
    if (row.key) {
      const holder = existing.byKey.get(row.key);
      if (holder && String(holder.id) !== String(record.id)) {
        row.errors.push({
          column: config.businessKeyHeader,
          message: `${config.businessKeyHeader} "${row.raw[config.businessKeyHeader] ?? row.key}" already belongs to another record`,
        });
        return;
      }
    }

    if (config.checkUpdate) {
      const problem = config.checkUpdate(record, row.values);
      if (problem) {
        row.errors.push({ column: config.businessKeyHeader, message: problem });
        return;
      }
    }

    // A re-uploaded export is mostly rows nobody edited. Saying so, and not
    // calling the service for them, is the difference between "238 updated"
    // and the truth.
    const changes = {};
    for (const column of applicableColumns(config)) {
      const next = row.values[column.field];
      if (next === undefined) continue;
      if (!sameValue(column, record[column.field], next)) {
        changes[column.header] = { from: record[column.field] ?? null, to: next };
      }
    }

    row.recordId = record.id;
    row.changes = changes;
    row.status = Object.keys(changes).length ? 'UPDATE' : 'UNCHANGED';
  }

  static count(rows) {
    return {
      totalRows: rows.length,
      validRows: rows.filter((row) => row.status !== 'ERROR').length,
      newRows: rows.filter((row) => row.status === 'NEW').length,
      updateRows: rows.filter((row) => row.status === 'UPDATE').length,
      errorRows: rows.filter((row) => row.status === 'ERROR').length,
    };
  }

  /** What the dialog shows. Big files send a slice; the error workbook has them all. */
  static preview(run, { config, context, warnings, estimate, canViewRates = true } = {}) {
    const rows = run.payload?.rows || [];
    const errorRows = rows.filter((row) => row.status === 'ERROR');
    const shown = rows.length <= PREVIEW_ROW_LIMIT
      ? rows
      : [...errorRows, ...rows.filter((row) => row.status !== 'ERROR')].slice(0, PREVIEW_ROW_LIMIT);

    return {
      importId: run.id,
      module: run.module,
      label: config?.label,
      fileName: run.fileName,
      importMode: run.importMode,
      status: run.status,
      // Export-only columns are left out: the preview reads back what the file
      // said, and those are columns the file is never read for.
      columns: (config ? visibleColumns(config, { canViewRates }) : [])
        .filter((column) => !column.exportOnly)
        .map((column) => column.header),
      totalRows: run.totalRows,
      validRows: run.validRows,
      newRows: run.newRows,
      updateRows: run.updateRows,
      unchangedRows: rows.filter((row) => row.status === 'UNCHANGED').length,
      skippedRows: rows.filter((row) => row.status === 'SKIP').length,
      errorRows: run.errorRows,
      createdCount: run.createdCount,
      updatedCount: run.updatedCount,
      warnings: warnings || run.warnings || [],
      durationMs: run.durationMs,
      committedAt: run.committedAt,
      ...(estimate || {}),
      truncated: shown.length < rows.length,
      rows: shown.map((row) => ({
        rowNumber: row.rowNumber,
        status: row.status,
        note: row.note || null,
        errors: row.errors || [],
        changes: row.changes || null,
        values: row.raw,
      })),
      context: context?.resolved || null,
    };
  }

  // --- Commit --------------------------------------------------------------

  static async getRun(importId) {
    const run = await MasterImportRun.findByPk(importId);
    if (!run) throw new NotFoundError('That import is no longer available. Upload the file again.');
    return run;
  }

  /**
   * Writes the validated rows, in one transaction, through the business
   * services. Re-resolves every match first: a file validated ten minutes ago
   * may name a product somebody has since renamed or deleted.
   */
  static async commit(importId, { canViewRates, userId, can }) {
    const startedAt = Date.now();
    const run = await this.getRun(importId);
    const config = getConfig(run.module);
    this.assertCanSeeRates(config, canViewRates);
    this.assertCanWrite(config, run, can);

    if (run.status === 'COMMITTED') {
      throw new ConflictError(`${run.fileName} has already been imported (${run.createdCount} created, ${run.updatedCount} updated).`);
    }
    if (run.errorRows > 0) {
      throw new ValidationError(`${run.fileName} has ${run.errorRows} row${run.errorRows === 1 ? '' : 's'} with errors. Download the error file, fix them and upload again.`);
    }

    const rows = (run.payload?.rows || []).filter((row) => row.status === 'NEW' || row.status === 'UPDATE');
    if (!rows.length) {
      await run.update({ status: 'COMMITTED', committedAt: new Date(), createdCount: 0, updatedCount: 0 });
      return this.preview(run, { config });
    }

    const context = run.context || {};
    if (config.context) context.resolved = await config.context.resolve(context[config.context.param]);

    const existing = await this.loadExisting(config, context);
    const stale = [];
    for (const row of rows) {
      const record = (row.recordId && existing.byId.get(String(row.recordId))) || (row.key && existing.byKey.get(row.key)) || null;
      if (row.status === 'UPDATE' && !record) {
        stale.push(`Row ${row.rowNumber}: the record it updates no longer exists`);
      }
      if (row.status === 'NEW' && record) {
        stale.push(`Row ${row.rowNumber}: ${config.businessKeyHeader} "${row.raw[config.businessKeyHeader] ?? row.key}" has been created since this file was checked`);
      }
      row.record = record;
    }
    if (stale.length) {
      throw new ConflictError(
        `The data changed since this file was checked. Upload it again to re-check it.\n${stale.slice(0, 10).join('\n')}`
      );
    }

    let created = 0;
    let updated = 0;

    try {
      await sequelize.transaction(async () => {
        if (config.commitAll) {
          const result = await config.commitAll({ rows, context });
          created = result.created;
          updated = result.updated;
          return;
        }
        // Every key and every reference in this file was checked in bulk a
        // moment ago, and re-checked against the database immediately above.
        // Telling the services so takes a product row from six database round
        // trips to two — on a remote database, the difference between two
        // minutes and forty seconds for a thousand rows. The unique indexes and
        // foreign keys still run, so nothing rests on this being right.
        const options = { preVerified: true };

        for (const row of rows) {
          if (row.status === 'NEW') {
            await config.create(row.values, context, options);
            created += 1;
          } else {
            await config.update(row.record, row.values, context, options);
            updated += 1;
          }
        }
      });
    } catch (error) {
      await run.update({ status: 'FAILED', errorMessage: error.message, durationMs: Date.now() - startedAt });
      logger.warn({ message: '[IMPORT] rolled back', module: config.key, importId: run.id, error: error.message });
      // The row number is what makes a service refusal actionable in a file of
      // 500 rows, so it is carried into the message rather than left behind.
      throw new ValidationError(`Nothing was imported. ${error.message}`);
    }

    await run.update({
      status: 'COMMITTED',
      createdCount: created,
      updatedCount: updated,
      committedAt: new Date(),
      durationMs: Date.now() - startedAt,
      userId: userId || run.userId,
    });

    logger.info({
      message: '[IMPORT] committed',
      module: config.key,
      importId: run.id,
      file: run.fileName,
      rows: run.totalRows,
      created,
      updated,
      failed: 0,
      durationMs: run.durationMs,
    });

    return this.preview(await this.getRun(importId), { config });
  }

  // --- Errors and history --------------------------------------------------

  static async errorWorkbook(importId, { canViewRates }) {
    const run = await this.getRun(importId);
    const config = getConfig(run.module);
    const rows = (run.payload?.rows || []).filter((row) => row.status === 'ERROR');
    if (!rows.length) throw new ValidationError('That import had no failed rows.');

    const buffer = await buildErrorWorkbook({
      label: config.label,
      columns: visibleColumns(config, { canViewRates }).filter((column) => !column.exportOnly),
      rows,
    });
    return { buffer, fileName: `${config.fileBase}_Import_Errors_${todayLocal()}.xlsx` };
  }

  static async listRuns({ module, page = 1, limit = 10 }) {
    const where = module ? { module } : {};
    const { rows, count } = await MasterImportRun.findAndCountAll({
      where,
      attributes: { exclude: ['payload'] },
      order: [['createdAt', 'DESC']],
      limit: Number(limit),
      offset: (Number(page) - 1) * Number(limit),
    });
    return { rows, count };
  }

  /**
   * Old runs stop holding a copy of the file.
   *
   * The run itself is the audit record of who imported what and when, so it is
   * kept forever. `payload` is a full copy of the uploaded rows, kept only so
   * the commit and the error download have something to read, and there is no
   * reason for that to sit in the database for months. A run that was never
   * committed is nothing but that copy, so it goes entirely.
   */
  static async prune() {
    const cutoff = new Date(Date.now() - RUN_RETENTION_DAYS * 86400000);
    await MasterImportRun.destroy({ where: { createdAt: { [Op.lt]: cutoff }, status: { [Op.ne]: 'COMMITTED' } } });
    await MasterImportRun.update(
      // Status stays COMMITTED: what the run did is the part worth keeping.
      { payload: null },
      { where: { createdAt: { [Op.lt]: cutoff }, status: 'COMMITTED', payload: { [Op.ne]: null } } }
    );
  }
}

module.exports = { MasterDataService, IMPORT_MODES };
