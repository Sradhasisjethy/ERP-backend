const { DataTypes } = require('sequelize');
const { sequelize } = require('../../config/database');
const { BaseAuditedModel } = require('../../core/AuditedModel');

const REPORT_TYPES = [
  'STOCK_AGEING', 'DASHBOARD_KPIS', 'COSTING', 'ALERTS', 'CANCELLATION_ANALYTICS',
  'DOCUMENT_SEARCH', 'TRIAL_BALANCE', 'PARTY_LEDGER', 'CASH_BOOK', 'GSTR1', 'GSTR3B',
];

/**
 * M40: a named, re-runnable report — `reportType` selects which already-built
 * read-only service method to call (see reports.service.js#RUNNERS), `params`
 * holds whatever that method needs (factoryId, date range, partyId, ...).
 * This is deliberately not a general query builder: every reportType maps to
 * a fixed, already-tested, BR-27-masked endpoint, so saving/running a report
 * can never expose more than the equivalent direct API call already would.
 */
class SavedReport extends BaseAuditedModel {}

SavedReport.initAudited(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING,
      allowNull: false,
    },
    reportType: {
      type: DataTypes.ENUM(...REPORT_TYPES),
      allowNull: false,
    },
    params: {
      type: DataTypes.JSONB,
      allowNull: false,
      defaultValue: {},
    },
  },
  {
    sequelize,
    tableName: 'saved_reports',
  }
);

module.exports = { SavedReport, REPORT_TYPES };
