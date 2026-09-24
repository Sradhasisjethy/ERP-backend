const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseScopedModel } = require('../../core/BaseModel');

/**
 * One row per uploaded file — the record of who imported what, and the bridge
 * between validating a file and committing it.
 *
 * It exists for two reasons that are easy to conflate:
 *
 *  1. **Audit.** BR-30 already records every created and updated record through
 *     BaseAuditedModel, but a thousand individual audit rows do not answer "who
 *     uploaded suppliers.xlsx on Tuesday and what did it do". This does.
 *  2. **A commit that cannot be forged.** The validated rows are held here, on
 *     the server, and the commit call names only this row id. If the client
 *     resent the rows it had validated, anyone could validate a clean file and
 *     commit a different one — the check would be real and meaningless.
 *
 * Deliberately BaseScopedModel, not BaseAuditedModel: this *is* an audit
 * record, and auditing it would write a second row saying the first was
 * written.
 */
class MasterImportRun extends BaseScopedModel {}

MasterImportRun.initScoped(
  {
    id: { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
    module: { type: DataTypes.STRING(64), allowNull: false },
    fileName: { type: DataTypes.STRING(255), allowNull: true },
    importMode: { type: DataTypes.STRING(16), allowNull: false, defaultValue: 'UPSERT' },
    status: {
      type: DataTypes.ENUM('VALIDATED', 'COMMITTED', 'FAILED', 'EXPIRED'),
      allowNull: false,
      defaultValue: 'VALIDATED',
    },
    totalRows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    validRows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    newRows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    updateRows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    errorRows: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    createdCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    updatedCount: { type: DataTypes.INTEGER, allowNull: false, defaultValue: 0 },
    // The validated rows, with their resolved values and per-row verdict. Read
    // back by the commit and by the error workbook download.
    payload: { type: DataTypes.JSONB, allowNull: true },
    // Whatever the module needs beyond the file itself, e.g. which price list
    // the rows belong to.
    context: { type: DataTypes.JSONB, allowNull: true },
    warnings: { type: DataTypes.JSONB, allowNull: true },
    errorMessage: { type: DataTypes.TEXT, allowNull: true },
    durationMs: { type: DataTypes.INTEGER, allowNull: true },
    userId: { type: DataTypes.UUID, allowNull: true },
    committedAt: { type: DataTypes.DATE, allowNull: true },
  },
  {
    sequelize,
    tableName: 'master_import_runs',
  }
);

module.exports = { MasterImportRun };
